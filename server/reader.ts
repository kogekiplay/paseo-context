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
import { record } from "./value";

const BOUNDARY_BYTES = 4_096;
const MAX_RESIDENT_BYTES = 64 * 1024 * 1024;
const RETAIN_MS = 120_000;
const BODY_MAX_CHARS = 8 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("base64");

interface Location { offset: number; length: number; digest: string }
interface FileIdentity { dev: number; ino: number }
interface Boundary { head: Buffer; tail: Buffer }
interface FoldEntry { fold: ContextFold; touched: number; residentBytes: number }
interface AppliedMetadata { index: number; type: AntigravityStep["type"]; key?: string }
interface Entry extends FileIdentity, FoldEntry {
  offset: number; tail: Buffer; tailOffset: number; finalized: boolean;
  locations: Location[]; boundary?: Boundary; valid: boolean;
  mtimeMs: number; ctimeMs: number;
  companion?: { fingerprint?: string; applied: AppliedMetadata[]; bytes: number };
}
interface DatabaseEntry extends FoldEntry { fingerprint: string }
export type ReadBodies = <T>(ids: readonly number[], project: (id: number, body: string) => T) => Promise<Map<number, T>>;
export interface NativeRead {
  path: string; entry: FoldEntry; bodies: ReadBodies; residentBytes: number;
  metadataOnly?: boolean; companionFailed?: boolean;
}

function sameFile(a: FileIdentity, b: FileIdentity) { return a.dev === b.dev && a.ino === b.ino; }
function sameTimes(a: Pick<Stats, "mtimeMs" | "ctimeMs">, b: Pick<Stats, "mtimeMs" | "ctimeMs">) {
  return a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

class ChangedLog extends Error {
  constructor() { super("Session log changed while reading; refresh the session and retry"); }
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
  return !companion || companion.fingerprint === snapshot?.fingerprint || companion.applied.every(({ index, type, key }) =>
    matchedMetadata(snapshot, index, type)?.key === key);
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
  private cache = new Map<string, Entry | DatabaseEntry>();
  private pending = new Map<string, { fingerprint?: string; read: Promise<NativeRead> }>();
  private bodies = new Map<string, string>();
  private bodyTimer?: ReturnType<typeof setTimeout>;

  constructor(roots: NativeRoots = {}) { this.paths = new NativePaths(roots, this.lifetime.signal); }

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
    let snapshot: AntigravitySnapshot | undefined;
    if (antigravity?.database) {
      try { snapshot = await this.paths.antigravity.read(antigravity.database); }
      catch (error) {
        if (antigravity.databaseOnly) throw error;
        ensureActive(this.lifetime.signal);
      }
    }
    if (antigravity?.databaseOnly) {
      if (!snapshot) throw new Error("Antigravity SQLite is unavailable");
      const cached = this.cache.get(path);
      const entry = cached && "fingerprint" in cached && cached.fingerprint === snapshot.fingerprint ? cached : (() => {
        const fold = foldDatabase(snapshot);
        return { fold, fingerprint: snapshot.fingerprint, touched: 0, residentBytes: fold.residentBytes };
      })();
      entry.touched = Date.now();
      this.remember(path, entry);
      return { path, entry, residentBytes: entry.residentBytes, metadataOnly: true, bodies: async (ids, project) => {
        ensureActive(this.lifetime.signal);
        return new Map([...new Set(ids)].map((id) => {
          if (!entry.fold.nodes[id]) throw new Error("Context item is no longer available");
          return [id, project(id, "")];
        }));
      } };
    }
    const sealed = source.sealed || agent.archived && !agent.running;
    const data = await this.readFile(agent, path, sealed, snapshot);
    return antigravity?.database && !snapshot ? { ...data, companionFailed: true } : data;
  }

  private async readFile(agent: Agent, path: string, sealed: boolean, snapshot?: AntigravitySnapshot): Promise<NativeRead> {
    const signal = this.lifetime.signal;
    for (let attempt = 0; ; attempt++) {
      ensureActive(signal);
      const file = await open(path, "r");
      const cached = this.cache.get(path);
      let entry = cached && "valid" in cached ? cached : undefined;
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error("Session source is not a file");
        ensureActive(signal);
        if (entry && (!await matchesPrefix(file, info, entry) || !sameMetadata(entry, snapshot))) {
          entry.valid = false;
          entry = undefined;
        }
        entry ??= {
          fold: new ContextFold(agent.provider), offset: 0, dev: info.dev, ino: info.ino, tail: Buffer.alloc(0), tailOffset: 0,
          locations: [], finalized: false, touched: 0, valid: true, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, residentBytes: 0,
          ...(agent.provider === "antigravity" ? { companion: { applied: [], bytes: 0 } } : {}),
        };
        if (entry.companion) entry.companion.fingerprint = snapshot?.fingerprint;
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
        entry.touched = Date.now();
        if (!entry.residentBytes || growing || finalize) {
          entry.residentBytes = entry.fold.residentBytes + entry.tail.length + entry.locations.length * 128
            + proof.head.length + proof.tail.length + (entry.companion?.bytes ?? 0);
        }
        this.remember(path, entry);
        return { path, entry, bodies: this.bodyReader({ path, entry }), residentBytes: entry.residentBytes };
      } catch (error) {
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

  private remember(path: string, entry: Entry | DatabaseEntry) {
    this.cache.delete(path);
    if (entry.residentBytes > MAX_RESIDENT_BYTES) return;
    this.cache.set(path, entry);
    let weight = [...this.cache.values()].reduce((sum, value) => sum + value.residentBytes, 0);
    for (const [key, value] of this.cache) {
      if (this.cache.size <= 8 && weight <= MAX_RESIDENT_BYTES && Date.now() - value.touched < RETAIN_MS) break;
      this.cache.delete(key);
      weight -= value.residentBytes;
    }
  }

  private rememberBody(key: string, body: string) {
    if (body.length > BODY_MAX_CHARS) return;
    this.bodies.delete(key);
    this.bodies.set(key, body);
    let chars = [...this.bodies.values()].reduce((n, text) => n + text.length, 0);
    for (const [key, text] of this.bodies) {
      if (this.bodies.size <= 4 && chars <= BODY_MAX_CHARS) break;
      this.bodies.delete(key);
      chars -= text.length;
    }
    clearTimeout(this.bodyTimer);
    this.bodyTimer = setTimeout(() => { this.bodies.clear(); this.bodyTimer = undefined; }, 30_000);
    this.bodyTimer.unref();
  }

  private bodyReader({ path, entry }: { path: string; entry: Entry }, revision = entry.fold.revision): ReadBodies {
    return async (ids, project) => {
      const signal = this.lifetime.signal;
      ensureActive(signal);
      const sources = new Map<number, number[]>();
      for (const id of new Set(ids)) {
        const node = entry.fold.nodes[id];
        if (!node) throw new Error("Context item is no longer available");
        const group = sources.get(node.line);
        if (group) group.push(id); else sources.set(node.line, [id]);
      }
      const result = new Map<number, ReturnType<typeof project>>();
      if (!sources.size) return result;
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
          for (const id of group) {
            const node = entry.fold.nodes[id];
            const key = `${entry.fold.epoch}:${line}:${node.block}:${location.digest}`;
            let body = canReuse ? this.bodies.get(key) : undefined;
            if (body !== undefined) reused = true;
            else {
              if (!messages) {
                const bytes = await readExactly(file, location.offset, location.length);
                ensureActive(signal);
                if (digest(bytes) !== location.digest) {
                  entry.valid = false;
                  if (this.cache.get(path) === entry) this.cache.delete(path);
                  throw new ChangedLog();
                }
                if (!entry.valid || revision !== entry.fold.revision) throw new ChangedLog();
                messages = messagesOf(JSON.parse(bytes.toString("utf8")), entry.fold.provider);
              }
              body = messages.find((message) => message.block === node.block)?.text ?? "";
            }
            this.rememberBody(key, body);
            result.set(id, project(id, body));
          }
        }
        const linked = await stat(path);
        if (!sameFile(entry, linked) || reused && !sameTimes(info, linked) || !entry.valid || revision !== entry.fold.revision) {
          throw new ChangedLog();
        }
        ensureActive(signal);
        return result;
      } finally { await file.close(); }
    };
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
    clearTimeout(this.bodyTimer);
    this.bodyTimer = undefined;
    this.paths.clear();
  }
}
