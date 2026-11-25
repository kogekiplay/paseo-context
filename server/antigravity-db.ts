import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import type * as Sqlite from "node:sqlite";
import type { ProviderTiming, Usage } from "../shared/contracts";
import { antigravityStepIndex, mergeAntigravityUsage, type AntigravityStep } from "./antigravity-log";
import { firstIndex, milliseconds, protobuf, protobufText } from "./antigravity-protobuf";
import { ensureActive } from "./paging";
import { RetainedCache } from "./retained-cache";

const LIMIT = 32;
const MAX_BYTES = 16 * 1024 * 1024;
const USER = 14, PLANNER = 15, CHECKPOINT = 23, TOOL = 132;

export interface AntigravityDatabaseFile { path: string; fingerprint: string; bytes: number }
interface StoredStep { facts: AntigravityStep; key: string }
interface StepIndex extends Iterable<[number, StoredStep]> {
  readonly size: number;
  get(index: number): StoredStep | undefined;
}
export interface AntigravitySnapshot {
  fingerprint: string;
  contentKey: string;
  steps: StepIndex;
  bytes: number;
}

function usageOf(value: unknown) {
  const fields = protobuf(value), usage: Partial<Usage> = {};
  const token = (tag: number) => antigravityStepIndex(fields.get(tag));
  for (const [name, tag] of [["input", 2], ["output", 3], ["cacheWrite", 4], ["cacheRead", 5], ["reasoning", 9]] as const) {
    const count = token(tag);
    if (count !== undefined) usage[name] = count;
  }
  const answer = token(10);
  if (usage.output === undefined && answer !== undefined && usage.reasoning !== undefined) {
    usage.output = answer + usage.reasoning;
  }
  // Proto3 omits scalar zero fields on the wire; a 100%-cached step omits tag 2.
  if (usage.input === undefined && (usage.cacheRead !== undefined || usage.cacheWrite !== undefined)) {
    usage.input = 0;
  }
  return { usage, responseId: protobufText(fields.get(11)) };
}

function readSteps(db: Sqlite.DatabaseSync) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
  const steps = new Map<number, StoredStep>();
  const ignored = tables.has("gen_metadata") ? new Set<number>() : undefined;
  let last = -1, ordered = true;
  const store = (index: number, facts: AntigravityStep) => {
    const previous = steps.get(index);
    if (previous) {
      previous.facts = facts;
      return;
    }
    ordered &&= index > last;
    last = index;
    steps.set(index, { facts, key: "" });
  };
  if (tables.has("steps")) for (const row of db.prepare(`
    SELECT idx, step_type, CASE WHEN step_type IN (${USER}, ${PLANNER}, ${CHECKPOINT}, ${TOOL}) THEN metadata END AS metadata
    FROM steps ORDER BY idx
  `).iterate()) {
    const index = antigravityStepIndex(row.idx), type = row.step_type;
    if (index === undefined || typeof type !== "number") continue;
    if (type !== USER && type !== PLANNER && type !== CHECKPOINT && type !== TOOL) {
      steps.delete(index);
      ignored?.add(index);
      continue;
    }
    ignored?.delete(index);
    const fields = protobuf(row.metadata);
    const time = (tag: number) => milliseconds(fields.get(tag)) || undefined;
    const at = time(1), usageAt = time(8);
    if (type === USER) store(index, { type: "USER_INPUT", at });
    if (type === TOOL) {
      const start = time(32);
      const end = usageAt !== undefined && (start === undefined || usageAt >= start) ? usageAt : undefined;
      store(index, { type: "GENERIC", at,
        tool: protobufText(protobuf(fields.get(4)).get(2)), times: { start, end } });
    }
    if (type === CHECKPOINT) store(index, { type: "CHECKPOINT", at, usageAt, ...usageOf(fields.get(9)) });
    if (type === PLANNER) {
      const first = time(6), rawEnd = time(7);
      const end = rawEnd !== undefined && (at === undefined || rawEnd >= at) ? rawEnd : undefined;
      const timing: ProviderTiming = { start: at, end,
        ttftMs: at !== undefined && first !== undefined && first >= at ? first - at : undefined,
        modelMs: at !== undefined && end !== undefined && end >= at ? end - at : undefined };
      store(index, { type: "PLANNER_RESPONSE", at, usageAt, ...usageOf(fields.get(9)), timing });
    }
  }
  if (ignored) for (const row of db.prepare("SELECT data FROM gen_metadata ORDER BY idx").iterate()) {
    const generator = protobuf(row.data), index = antigravityStepIndex(firstIndex(generator.get(2)));
    if (index === undefined || ignored.has(index)) continue;
    const planner = steps.get(index)?.facts;
    if (planner && planner.type !== "PLANNER_RESPONSE") continue;
    const fields = protobuf(generator.get(1));
    if (!fields.size) continue;
    const ttftMs = milliseconds(fields.get(11)), stream = milliseconds(fields.get(12));
    const { usage, responseId } = usageOf(fields.get(4));
    if (!planner && !Object.keys(usage).length && ttftMs === undefined) continue;
    store(index, { type: "PLANNER_RESPONSE", at: planner?.at, usageAt: planner?.usageAt,
      usage: mergeAntigravityUsage(planner?.usage, usage), responseId: responseId ?? planner?.responseId,
      timing: { ...planner?.timing, ttftMs: ttftMs ?? planner?.timing?.ttftMs,
        modelMs: ttftMs !== undefined && stream !== undefined ? ttftMs + stream : planner?.timing?.modelMs } });
  }
  return { steps, ordered };
}

function indexedContent(steps: StepIndex, extraBytes = 0): Omit<AntigravitySnapshot, "fingerprint"> {
  const hash = createHash("sha256");
  let bytes = extraBytes;
  for (const [index, step] of steps) {
    step.key = JSON.stringify(step.facts);
    hash.update(`${index}:${step.key}\n`);
    bytes += 320 + step.key.length * 2;
  }
  return { steps, bytes, contentKey: hash.digest("hex") };
}

function indexSteps({ steps, ordered }: ReturnType<typeof readSteps>): Omit<AntigravitySnapshot, "fingerprint"> {
  if (ordered) return indexedContent(steps);
  // A generator-only step can precede an existing row. Sort just the numeric
  // indices and keep a single copy of the lookup table.
  const indices = new Float64Array(steps.size);
  let offset = 0;
  for (const index of steps.keys()) indices[offset++] = index;
  indices.sort();
  return indexedContent({
    size: steps.size,
    get: (index) => steps.get(index),
    *[Symbol.iterator]() {
      for (const index of indices) yield [index, steps.get(index)!];
    },
  }, indices.byteLength);
}

async function sidecarHeader(path: string, expected: BigIntStats, length: number) {
  let file;
  try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw error;
  }
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || await realpath(path) !== path) return null;
    if (info.dev !== expected.dev || info.ino !== expected.ino) return;
    const header = Buffer.alloc(length);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead === length) return header;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  } finally { await file.close(); }
}

function validWalIndex(index: Buffer, wal: Buffer) {
  if (index[12] !== 1 || index[13] !== (wal[3] & 1) || !index.subarray(0, 48).equals(index.subarray(48))) return false;
  const littleEndian = index.readUInt32LE(0) === 3007000;
  if (!littleEndian && index.readUInt32BE(0) !== 3007000) return false;
  // SQLite uses native order for WalIndexHdr.aCksum. bigEndCksum describes the WAL frames.
  const word = (offset: number) => littleEndian ? index.readUInt32LE(offset) : index.readUInt32BE(offset);
  let first = 0, second = 0;
  for (let offset = 0; offset < 40; offset += 8) {
    first = (first + word(offset) + second) >>> 0;
    second = (second + word(offset + 4) + first) >>> 0;
  }
  return word(40) === first && word(44) === second;
}

// Inspect sidecars without following a symlink into another conversation or
// outside the provider's storage directory.
async function fingerprint(path: string) {
  const [main, wal, shm] = await Promise.all([path, `${path}-wal`, `${path}-shm`].map(async (name) => {
    try { return await lstat(name, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }));
  if (!main?.isFile() || wal && !wal.isFile() || shm && !shm.isFile()) return null;
  // A read-only SQLite connection can create or touch a zero-byte WAL.
  const activeWal = wal && wal.size > 0n ? wal : null;
  const mainKey = `${main.dev}:${main.ino}:${main.size}:${main.mtimeNs}:${main.ctimeNs}`;
  if (!activeWal) return { bytes: Number(main.size), fingerprint: `${mainKey}/` };
  const bytes = Number(main.size + activeWal.size);
  const [header, index] = await Promise.all([
    activeWal.size >= 32n ? sidecarHeader(`${path}-wal`, activeWal, 32) : undefined,
    shm && shm.size >= 96n ? sidecarHeader(`${path}-shm`, shm, 96) : undefined,
  ]);
  if (header === null || index === null) return null;
  // WalIndexHdr contains the committed frame number and checksum, even when SQLite reuses the WAL.
  if (!header || !index || !validWalIndex(index, header)) return { bytes, fingerprint: "" };
  const walKey = `${activeWal.dev}:${activeWal.ino}:${activeWal.size}:${activeWal.mtimeNs}:${header.toString("hex")}:${index.subarray(0, 48).toString("hex")}`;
  return { bytes, fingerprint: `${mainKey}/${walKey}` };
}

function sqlite(): typeof Sqlite | undefined {
  try { return process.getBuiltinModule?.("node:sqlite") as typeof Sqlite | undefined; }
  catch { return undefined; }
}

export class AntigravityDatabase {
  private cache = new RetainedCache<AntigravitySnapshot>(LIMIT, MAX_BYTES);

  constructor(private root: string, private signal: AbortSignal) {}

  async locate(id: string): Promise<AntigravityDatabaseFile | null> {
    try {
      const directory = await realpath(join(this.root, "conversations"));
      const path = join(directory, `${id}.db`);
      const key = await fingerprint(path);
      ensureActive(this.signal);
      if (!key || !sqlite()) return null;
      if (await realpath(path) !== path) return null;
      return { path, ...key };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  // SessionReader reserves the database and transcript together while this snapshot is in use.
  async read({ path }: AntigravityDatabaseFile, account: (bytes: number) => void): Promise<AntigravitySnapshot> {
    const module = sqlite();
    if (!module) throw new Error("Antigravity SQLite is unavailable");
    for (let attempt = 0; attempt < 2; attempt++) {
      ensureActive(this.signal);
      if (await realpath(path) !== path) break;
      const current = await fingerprint(path);
      if (!current) break;
      ensureActive(this.signal);
      const key = current.fingerprint, cached = this.cache.get(path);
      if (key && cached?.fingerprint === key) return cached;
      account(current.bytes);
      const db = new module.DatabaseSync(path, { readOnly: true, timeout: 250 });
      let facts: ReturnType<typeof readSteps>;
      let begun = false;
      try {
        db.exec("BEGIN");
        begun = true;
        facts = readSteps(db);
      } finally {
        if (begun) { try { db.exec("ROLLBACK"); } catch {} }
        db.close();
      }
      const after = await fingerprint(path);
      if (!after || await realpath(path) !== path) break;
      ensureActive(this.signal);
      if (!key) return { fingerprint: "", ...indexSteps(facts) };
      if (after.fingerprint !== key) {
        if (attempt === 0) continue;
        // This transaction still read a consistent snapshot. A new write
        // prevents it from being cached under either on-disk fingerprint.
        return { fingerprint: "", ...indexSteps(facts) };
      }
      const snapshot = { fingerprint: key, ...indexSteps(facts) };
      this.cache.set(path, snapshot, snapshot.bytes);
      return snapshot;
    }
    throw new Error("Antigravity database changed while reading");
  }

  clear() { this.cache.clear(); }
}
