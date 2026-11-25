import { ensureActive } from "./paging";
import { open, stat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import type { Agent } from "../shared/contracts";
import { ContextFold } from "./fold";
import { NativePaths, type NativeLocation, type NativeRoots } from "./native-paths";
import { messagesOf } from "./normalize";
import { antigravityStepIndex, type AntigravityStep } from "./antigravity-log";
import type { AntigravitySnapshot } from "./antigravity-db";
import { detachSlice, record, stringBytes, type RecordValue } from "./value";
import { MIB, sessionReadBudget, type AccountRead, type ReadBudget } from "./read-budget";
import { RetainedCache } from "./retained-cache";

const BOUNDARY_BYTES = 4_096;
const MAX_RESIDENT_BYTES = 64 * 1024 * 1024;
const BODY_MAX_BYTES = 16 * MIB;
const logReadBytes = (bytes: number) => 5 * bytes;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("base64");

interface Location { offset: number; length: number; digest: string }
interface FileIdentity { dev: number; ino: number }
interface Boundary { head: Buffer; tail: Buffer }
interface FoldEntry { fold: ContextFold; residentBytes: number }
interface AppliedMetadata { index: number; type: AntigravityStep["type"]; key?: string }
interface Entry extends FileIdentity, FoldEntry {
  offset: number; tail: Buffer; tailOffset: number; finalized: boolean;
  locations: Location[]; boundary?: Boundary; valid: boolean;
  mtimeMs: number; ctimeMs: number;
  companion?: { contentKey?: string; applied: AppliedMetadata[]; bytes: number };
}
interface DatabaseEntry extends FoldEntry { contentKey: string }
export type ReadBodies = <T>(ids: readonly number[], project: (id: number, body: string) => T) => Promise<Map<number, T>>;
export type ReadMedia = (id: number, index: number, maxBytes: number) => Promise<string | null>;
export interface NativeRead {
  path: string; entry: FoldEntry; bodies: ReadBodies; residentBytes: number;
  media?: ReadMedia; metadataOnly?: boolean; companionFailed?: boolean;
}

function sameFile(a: FileIdentity, b: FileIdentity) { return a.dev === b.dev && a.ino === b.ino; }
function sameTimes(a: Pick<Stats, "mtimeMs" | "ctimeMs">, b: Pick<Stats, "mtimeMs" | "ctimeMs">) {
  return a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

class ChangedLog extends Error {
  constructor() { super("Session log changed while reading; refresh the session and retry"); }
}

class NeedsLargerBudget extends Error {
  constructor(readonly bytes: number) { super("Session size changed while reserving read capacity; retry the read"); }
}

async function readExactly(file: FileHandle, offset: number, length: number) {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await file.read(bytes, read, length - read, offset + read);
    if (!bytesRead) throw new ChangedLog();
    read += bytesRead;
  }
  return bytes;
}

async function boundaries(file: FileHandle, size: number): Promise<Boundary> {
  const length = Math.min(BOUNDARY_BYTES, size);
  const head = await readExactly(file, 0, length);
  const tail = size <= length ? head : await readExactly(file, size - length, length);
  return { head, tail };
}

function sameBoundary(first: Boundary, second: Boundary) {
  return first.head.equals(second.head) && first.tail.equals(second.tail);
}

async function matchesPrefix(file: FileHandle, info: Stats, entry: Entry) {
  if (!entry.valid || !sameFile(entry, info) || info.size < entry.offset) return false;
  if (info.size === entry.offset) return sameTimes(entry, info);
  if (entry.finalized) return false;
  return !entry.boundary || sameBoundary(entry.boundary, await boundaries(file, entry.offset));
}

function matchedMetadata(snapshot: AntigravitySnapshot | undefined, index: number, type: unknown) {
  const step = snapshot?.steps.get(index);
  return step?.facts.type === type ? step : undefined;
}

function sameMetadata(entry: Entry, snapshot: AntigravitySnapshot | undefined) {
  const companion = entry.companion;
  return !companion || companion.contentKey === snapshot?.contentKey
    || companion.applied.every(({ index, type, key }) => matchedMetadata(snapshot, index, type)?.key === key);
}

function foldDatabase(snapshot: AntigravitySnapshot) {
  const fold = new ContextFold("antigravity");
  const calls = new Map<number, Array<{ name?: string }>>();
  let pending: Array<{ name?: string }> | undefined;
  let lastNonGeneric = -1;
  for (const [index, { facts }] of snapshot.steps) {
    if (facts.type !== "GENERIC") lastNonGeneric = Math.max(lastNonGeneric, index);
    if (facts.type === "PLANNER_RESPONSE") calls.set(index, pending = []);
    else if (facts.type === "GENERIC") pending?.push({ name: facts.tool });
    else pending = undefined;
  }
  for (const [index, { facts }] of snapshot.steps) {
    fold.apply({ type: facts.type, step_index: index, tool_calls: calls.get(index),
      ...(facts.type === "GENERIC" && facts.times.end === undefined && index > lastNonGeneric ? { status: "RUNNING" } : {}) }, facts, true);
  }
  return fold;
}

export class SessionReader {
  private lifetime = new AbortController();
  private paths: NativePaths;
  private cache = new RetainedCache<Entry | DatabaseEntry>(8, MAX_RESIDENT_BYTES);
  private pending = new Map<string, { fingerprint?: string; read: Promise<NativeRead> }>();
  private bodies = new RetainedCache<string>(4, BODY_MAX_BYTES, 30_000);

  constructor(roots: NativeRoots = {}, readonly budget: ReadBudget = sessionReadBudget) {
    this.paths = new NativePaths(roots, this.lifetime.signal);
  }

  locateSource(agent: Agent) { return this.paths.locate(agent); }
  async locate(agent: Agent) { return (await this.locateSource(agent))?.path ?? null; }
  locateForScan(agents: readonly Agent[]) { return this.paths.forAgents(agents); }

  async read(agent: Agent, location?: NativeLocation | null): Promise<NativeRead | null> {
    const source = location === undefined ? await this.paths.locate(agent) : location;
    if (!source) return null;
    const signal = this.lifetime.signal;
    ensureActive(signal);
    const fingerprint = source.antigravity?.database?.fingerprint;
    const active = this.pending.get(source.path);
    if (active) {
      if (active.fingerprint === fingerprint) return active.read;
      await active.read.catch(() => {});
      return this.read(agent);
    }
    const pending = { fingerprint, read: this.readSource(agent, source) };
    this.pending.set(source.path, pending);
    try { return await pending.read; }
    finally { if (this.pending.get(source.path) === pending) this.pending.delete(source.path); }
  }

  private async readSource(agent: Agent, source: NativeLocation): Promise<NativeRead> {
    const { path, antigravity } = source;
    const signal = this.lifetime.signal;
    const sealed = source.sealed || agent.archived && !agent.running;
    const info = antigravity?.databaseOnly ? undefined : await stat(path);
    const cached = this.cache.peek(path);
    // A freshly read snapshot can reuse the transcript even while the WAL
    // changes. Reserve for a replay only if its applied facts differ.
    const unchanged = info && cached && "valid" in cached && cached.valid && sameFile(cached, info)
      && info.size === cached.offset && sameTimes(cached, info) && !(sealed && cached.tail.length);
    let logBytes = unchanged ? 0 : info?.size ?? 0;
    let dbBytes = antigravity?.database?.bytes ?? 0;
    const estimate = () => MIB + logReadBytes(logBytes) + 4 * dbBytes;
    const limit = this.budget.maxBytes;
    let reserved = Math.min(estimate(), limit);
    for (let retries = 0; ; retries++) {
      const account = (grow?: AccountRead) => {
        const required = Math.min(estimate(), limit);
        if (required <= reserved) return;
        // Small live WAL growth can use free capacity without making a queued replay bypass it.
        if (!grow || required - reserved > MIB || !grow(required, true)) throw new NeedsLargerBudget(required);
        reserved = required;
      };
      try {
        return await this.budget.run(reserved, signal, (grow) => this.readReserved(agent, source, sealed, (bytes) => {
          dbBytes = bytes;
          account(grow);
        }, (bytes) => {
          logBytes = bytes;
          account();
        }));
      } catch (error) {
        if (!(error instanceof NeedsLargerBudget) || error.bytes <= reserved) throw error;
        // If the source keeps growing, reserve the full capacity for the final retry.
        reserved = retries >= 3 ? limit : error.bytes;
      }
    }
  }

  private async readReserved(agent: Agent, source: NativeLocation, sealed: boolean,
    accountDatabase: (bytes: number) => void, accountLog: (bytes: number) => void): Promise<NativeRead> {
    const { path, antigravity } = source;
    let snapshot: AntigravitySnapshot | undefined;
    if (antigravity?.database) {
      try { snapshot = await this.paths.antigravity.read(antigravity.database, accountDatabase); }
      catch (error) {
        if (antigravity.databaseOnly || error instanceof NeedsLargerBudget) throw error;
        ensureActive(this.lifetime.signal);
      }
    }
    ensureActive(this.lifetime.signal);
    if (antigravity?.databaseOnly) {
      if (!snapshot) throw new Error("Antigravity SQLite is unavailable");
      const cached = this.cache.peek(path);
      const entry = cached && "contentKey" in cached && cached.contentKey === snapshot.contentKey ? cached : (() => {
        const fold = foldDatabase(snapshot);
        return { fold, contentKey: snapshot.contentKey, residentBytes: fold.residentBytes };
      })();
      this.cache.set(path, entry, entry.residentBytes);
      return { path, entry, residentBytes: entry.residentBytes, metadataOnly: true, bodies: async (ids, project) => {
        ensureActive(this.lifetime.signal);
        return new Map([...new Set(ids)].map((id) => {
          if (!entry.fold.nodes[id]) throw new Error("Context item is no longer available");
          return [id, project(id, "")];
        }));
      } };
    }
    const data = await this.readFile(agent, path, sealed, accountLog, snapshot);
    return antigravity?.database && !snapshot ? { ...data, companionFailed: true } : data;
  }

  private async readFile(agent: Agent, path: string, sealed: boolean, account: (bytes: number) => void, snapshot?: AntigravitySnapshot): Promise<NativeRead> {
    const signal = this.lifetime.signal;
    for (let attempt = 0; ; attempt++) {
      ensureActive(signal);
      const file = await open(path, "r");
      const cached = this.cache.peek(path);
      let entry = cached && "valid" in cached ? cached : undefined;
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error("Session source is not a file");
        ensureActive(signal);
        const reuse = entry && await matchesPrefix(file, info, entry) && sameMetadata(entry, snapshot);
        const offset = reuse ? entry!.offset : 0;
        if (info.size > offset || sealed) account(info.size - offset + (reuse ? entry!.tail.length : 0));
        if (entry && !reuse) {
          entry.valid = false;
          entry = undefined;
        }
        entry ??= {
          fold: new ContextFold(agent.provider), offset: 0, dev: info.dev, ino: info.ino, tail: Buffer.alloc(0), tailOffset: 0,
          locations: [], finalized: false, valid: true, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, residentBytes: 0,
          ...(agent.provider === "antigravity" ? { companion: { applied: [], bytes: 0 } } : {}),
        };
        if (entry.companion) entry.companion.contentKey = snapshot?.contentKey;
        const growing = info.size > entry.offset;
        const proof = !entry.boundary || growing ? await boundaries(file, info.size) : entry.boundary;
        if (growing) await this.scan(file, info.size, entry, signal, snapshot);
        const finalize = sealed && entry.tail.length > 0 && !entry.finalized;
        if (finalize) {
          this.append(entry, entry.tail, snapshot);
          entry.tail = Buffer.alloc(0);
          entry.finalized = true;
        }
        const current = await file.stat();
        const linked = await stat(path);
        if (!sameFile(info, linked) || current.size < info.size || current.size === info.size && !sameTimes(info, current)
          || growing && !sameBoundary(proof, await boundaries(file, info.size))) throw new ChangedLog();
        ensureActive(signal);
        entry.offset = info.size;
        entry.mtimeMs = info.mtimeMs;
        entry.ctimeMs = info.ctimeMs;
        entry.boundary = proof;
        if (!entry.residentBytes || growing || finalize) {
          entry.residentBytes = entry.fold.residentBytes + entry.tail.length + entry.locations.length * 168
            + proof.head.length + proof.tail.length + (entry.companion?.bytes ?? 0);
        }
        this.cache.set(path, entry, entry.residentBytes);
        const stable = { path, entry, revision: entry.fold.revision };
        const bodies: ReadBodies = (ids, project) => this.readNodes(stable, ids, project);
        const media: ReadMedia = async (id, index, maxBytes) => {
          const found = await this.readNodes(stable, [id], (_id, _body, row) => {
            const items = row?.media;
            return Array.isArray(items) ? this.paths.image(agent, items[index], maxBytes) : null;
          }, { raw: true, bytes: maxBytes * 4 });
          return found.get(id) ?? null;
        };
        return { path, entry, bodies, residentBytes: entry.residentBytes,
          ...(agent.provider === "antigravity" ? { media } : {}) };
      } catch (error) {
        if (error instanceof NeedsLargerBudget) throw error;
        if (entry) entry.valid = false;
        this.cache.delete(path);
        if (!(error instanceof ChangedLog) || attempt > 0) throw error;
      } finally { await file.close(); }
    }
  }

  private async scan(file: FileHandle, size: number, entry: Entry, signal: AbortSignal, snapshot?: AntigravitySnapshot) {
    let fragments = entry.tail.length ? [entry.tail] : [];
    const stream = file.createReadStream({ start: entry.offset, end: size - 1, autoClose: false, signal });
    for await (const bytes of stream as AsyncIterable<Buffer>) {
      let start = 0;
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
        const chunk = bytes.subarray(start, end);
        const line = fragments.length ? Buffer.concat([...fragments, chunk]) : chunk;
        this.append(entry, line, snapshot);
        entry.tailOffset++;
        fragments = [];
        start = end + 1;
      }
      if (start < bytes.length) fragments.push(bytes.subarray(start));
    }
    entry.tail = Buffer.concat(fragments);
  }

  private append(entry: Entry, line: Buffer, snapshot?: AntigravitySnapshot) {
    const value = line.toString("utf8");
    let row: unknown;
    try { row = value.trim() ? JSON.parse(value) : {}; }
    catch { throw new Error(`Session log contains an invalid JSON record at line ${entry.locations.length + 1}`); }
    let step: AntigravityStep | undefined;
    if (entry.companion) {
      const { step_index, type } = record(row);
      const index = antigravityStepIndex(step_index);
      if (index !== undefined && (type === "USER_INPUT" || type === "PLANNER_RESPONSE" || type === "GENERIC" || type === "CHECKPOINT")) {
        const metadata = matchedMetadata(snapshot, index, type);
        entry.companion.applied.push({ index, type, key: metadata?.key });
        entry.companion.bytes += 72 + (metadata?.key.length ?? 0) * 2;
        step = metadata?.facts;
      }
    }
    entry.fold.apply(row, step);
    entry.locations.push({ offset: entry.tailOffset, length: line.length, digest: digest(line) });
    entry.tailOffset += line.length;
  }

  private async readNodes<T>({ path, entry, revision }: { path: string; entry: Entry; revision: number },
    ids: readonly number[], project: (id: number, body: string, row?: RecordValue) => T | Promise<T>,
    options?: { raw: true; bytes: number }): Promise<Map<number, T>> {
    const signal = this.lifetime.signal;
    ensureActive(signal);
    const sources = new Map<number, number[]>();
    for (const id of new Set(ids)) {
      const node = entry.fold.nodes[id];
      if (!node) throw new Error("Context item is no longer available");
      const group = sources.get(node.line);
      if (group) group.push(id); else sources.set(node.line, [id]);
    }
    const result = new Map<number, T>();
    if (!sources.size) return result;
    if (!entry.valid || revision !== entry.fold.revision) throw new ChangedLog();
    let bytes = MIB + (options?.bytes ?? 0);
    for (const line of sources.keys()) bytes += logReadBytes(entry.locations[line - 1].length);
    return this.budget.run(bytes, signal, async () => {
      if (!entry.valid || revision !== entry.fold.revision) throw new ChangedLog();
      const file = await open(path, "r");
      try {
        const info = await file.stat();
        if (!sameFile(entry, info)) throw new ChangedLog();
        const canReuse = info.size === entry.offset && sameTimes(entry, info);
        let reused = false;
        for (const [line, group] of sources) {
          ensureActive(signal);
          const location = entry.locations[line - 1];
          let messages: ReturnType<typeof messagesOf> | undefined;
          let row: RecordValue | undefined;
          for (const id of group) {
            const node = entry.fold.nodes[id];
            const key = `${entry.fold.epoch}:${line}:${node.block}:${location.digest}`;
            if (!options && canReuse) {
              const cached = this.bodies.get(key);
              if (cached !== undefined) {
                reused = true;
                result.set(id, await project(id, cached));
                continue;
              }
            }
            if (!row) {
              const bytes = await readExactly(file, location.offset, location.length);
              ensureActive(signal);
              if (digest(bytes) !== location.digest) {
                entry.valid = false;
                if (this.cache.peek(path) === entry) this.cache.delete(path);
                throw new ChangedLog();
              }
              if (!entry.valid || revision !== entry.fold.revision) throw new ChangedLog();
              row = record(JSON.parse(bytes.toString("utf8")));
            }
            if (options?.raw) {
              result.set(id, await project(id, "", row));
              continue;
            }
            messages ??= messagesOf(row, entry.fold.provider);
            const body = messages.find((message) => message.block === node.block)?.text ?? "";
            const weight = stringBytes(body) + stringBytes(key) + 64;
            if (weight <= BODY_MAX_BYTES) this.bodies.set(key, detachSlice(body), weight);
            result.set(id, await project(id, body));
          }
        }
        const linked = await stat(path);
        if (!sameFile(entry, linked) || reused && !sameTimes(info, linked) || !entry.valid || revision !== entry.fold.revision) {
          throw new ChangedLog();
        }
        ensureActive(signal);
        return result;
      } finally { await file.close(); }
    });
  }

  async content(agent: Agent, nodeId: number): Promise<string> {
    const data = await this.read(agent);
    if (!data) throw new Error("Context item is no longer available");
    return (await data.bodies([nodeId], (_id, body) => body)).get(nodeId)!;
  }

  clear() {
    this.lifetime.abort();
    this.cache.clear();
    this.pending.clear();
    this.bodies.clear();
    this.paths.clear();
  }
}
