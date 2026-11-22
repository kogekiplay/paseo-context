import { lstat, realpath } from "node:fs/promises";
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
export interface AntigravitySnapshot {
  fingerprint: string;
  steps: ReadonlyMap<number, StoredStep>;
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

function readSteps(db: Sqlite.DatabaseSync): Map<number, AntigravityStep> {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
  const steps = new Map<number, AntigravityStep>(), types = new Map<number, number>();
  if (tables.has("steps")) for (const row of db.prepare(`
    SELECT idx, step_type, CASE WHEN step_type IN (${USER}, ${PLANNER}, ${CHECKPOINT}, ${TOOL}) THEN metadata END AS metadata
    FROM steps ORDER BY idx
  `).iterate()) {
    const index = antigravityStepIndex(row.idx), type = row.step_type;
    if (index === undefined || typeof type !== "number") continue;
    types.set(index, type);
    if (![USER, PLANNER, CHECKPOINT, TOOL].includes(type)) continue;
    const fields = protobuf(row.metadata);
    const time = (tag: number) => milliseconds(fields.get(tag)) || undefined;
    const at = time(1), usageAt = time(8);
    if (type === USER) steps.set(index, { type: "USER_INPUT", at });
    if (type === TOOL) {
      const start = time(32);
      const end = usageAt !== undefined && (start === undefined || usageAt >= start) ? usageAt : undefined;
      steps.set(index, { type: "GENERIC", at,
        tool: protobufText(protobuf(fields.get(4)).get(2)), times: { start, end } });
    }
    if (type === CHECKPOINT) steps.set(index, { type: "CHECKPOINT", at, usageAt, ...usageOf(fields.get(9)) });
    if (type === PLANNER) {
      const first = time(6), rawEnd = time(7);
      const end = rawEnd !== undefined && (at === undefined || rawEnd >= at) ? rawEnd : undefined;
      const timing: ProviderTiming = { start: at, end,
        ttftMs: at !== undefined && first !== undefined && first >= at ? first - at : undefined,
        modelMs: at !== undefined && end !== undefined && end >= at ? end - at : undefined };
      steps.set(index, { type: "PLANNER_RESPONSE", at, usageAt, ...usageOf(fields.get(9)), timing });
    }
  }
  if (tables.has("gen_metadata")) for (const row of db.prepare("SELECT data FROM gen_metadata ORDER BY idx").iterate()) {
    const generator = protobuf(row.data), index = antigravityStepIndex(firstIndex(generator.get(2)));
    if (index === undefined || types.has(index) && types.get(index) !== PLANNER) continue;
    const fields = protobuf(generator.get(1));
    if (!fields.size) continue;
    const previous = steps.get(index);
    const planner = previous?.type === "PLANNER_RESPONSE" ? previous : undefined;
    const ttftMs = milliseconds(fields.get(11)), stream = milliseconds(fields.get(12));
    const { usage, responseId } = usageOf(fields.get(4));
    if (!planner && !Object.keys(usage).length && ttftMs === undefined && stream === undefined) continue;
    steps.set(index, { type: "PLANNER_RESPONSE", at: planner?.at, usageAt: planner?.usageAt,
      usage: mergeAntigravityUsage(planner?.usage, usage), responseId: responseId ?? planner?.responseId,
      timing: { ...planner?.timing, ttftMs: ttftMs ?? planner?.timing?.ttftMs,
        modelMs: ttftMs !== undefined && stream !== undefined ? ttftMs + stream : planner?.timing?.modelMs } });
  }
  return steps;
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
  return { bytes: Number(main.size + (wal?.size ?? 0n)),
    fingerprint: [main, wal].map((file) => file ? `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}` : "").join("/") };
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
  async read({ path, fingerprint: key }: AntigravityDatabaseFile, account: (bytes: number) => void): Promise<AntigravitySnapshot> {
    const module = sqlite();
    if (!module) throw new Error("Antigravity SQLite is unavailable");
    for (let attempt = 0; attempt < 2; attempt++) {
      ensureActive(this.signal);
      const cached = this.cache.get(path);
      if (cached?.fingerprint === key) return cached;
      if (await realpath(path) !== path) break;
      const current = await fingerprint(path);
      if (!current) break;
      if (current.fingerprint !== key) {
        key = current.fingerprint;
        continue;
      }
      ensureActive(this.signal);
      account(current.bytes);
      const db = new module.DatabaseSync(path, { readOnly: true, timeout: 250 });
      let facts: Map<number, AntigravityStep>;
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
      ensureActive(this.signal);
      if (!after) break;
      if (after.fingerprint !== key) { key = after.fingerprint; continue; }
      const steps = new Map<number, StoredStep>();
      let bytes = 0;
      for (const [index, fact] of [...facts].sort(([a], [b]) => a - b)) {
        const stepKey = JSON.stringify(fact);
        steps.set(index, { facts: fact, key: stepKey });
        bytes += 320 + stepKey.length * 2;
      }
      const snapshot = { fingerprint: key, steps, bytes };
      this.cache.set(path, snapshot, bytes);
      return snapshot;
    }
    throw new Error("Antigravity database changed while reading");
  }

  clear() { this.cache.clear(); }
}
