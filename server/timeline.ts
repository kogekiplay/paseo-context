import type { PaseoApi } from "@getpaseo/client";
import { createHash } from "node:crypto";
import type { Request, Summary } from "../shared/contracts";
import { ContextFold } from "./fold";
import { messagesOf } from "./normalize";
import { ensureActive, timelineAfter, timelineHistory } from "./paging";
import type { ReadBodies } from "./reader";
import { record, stringBytes } from "./value";
import { MIB, sessionReadBudget, TIMELINE_PAGE_BYTES, type AccountRead } from "./read-budget";
import { RetainedCache } from "./retained-cache";

type Page = Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>;
type TimelineEntry = Page["entries"][number];
interface Frame {
  fold: ContextFold;
  entries: TimelineEntry[];
  cursor: Page["endCursor"];
  bytes: number;
  residentBytes: number;
}
const RESIDENT_LIMIT = 48 * 1024 * 1024;
const HASH_CHUNK_CHARS = 64 * 1024;
const rowOf = (entry: TimelineEntry) => ({ ...record(entry.item), timestamp: entry.timestamp });

// Timeline items are JSON DTOs. Weigh their strings and containers without serializing a second copy.
function itemBytes(value: unknown): number {
  if (typeof value === "string") return stringBytes(value);
  if (typeof value !== "object" || value === null) return 8;
  let bytes = 48;
  if (Array.isArray(value)) {
    for (const item of value) bytes += 8 + itemBytes(item);
    return bytes;
  }
  const row = record(value);
  for (const key in row) if (Object.hasOwn(row, key)) bytes += 24 + stringBytes(key) + itemBytes(row[key]);
  return bytes;
}
const sizeOf = (entries: readonly TimelineEntry[]) => entries.reduce((size, entry) =>
  size + itemBytes(entry.item) + 128, 0);

/** Stream length-delimited collections so a large history never needs one JSON string. */
export function timelineFingerprint(key: string, fold: ContextFold, summary: Summary, requests: readonly Request[]) {
  const hash = createHash("sha256");
  const chunk: string[] = [];
  let chars = 0;
  const flush = () => {
    if (!chars) return;
    hash.update(chunk.join(""));
    chunk.length = 0;
    chars = 0;
  };
  const write = (value: unknown) => {
    const row = `${JSON.stringify(value) ?? "null"}\n`;
    if (chars + row.length > HASH_CHUNK_CHARS) flush();
    if (row.length >= HASH_CHUNK_CHARS) hash.update(row);
    else {
      chunk.push(row);
      chars += row.length;
    }
  };
  const rows = <T>(items: readonly T[] | undefined, writeRow: (item: T) => void = write) => {
    write(items?.length ?? null);
    if (items) for (const item of items) writeRow(item);
  };
  const { intervals, activity, tools, skills, programs, ...metrics } = summary;
  write([key, fold.revision, fold.epoch, metrics]);
  rows(intervals);
  rows(tools);
  rows(skills);
  rows(programs);
  rows(activity, (day) => {
    write(day.time);
    rows(day.tools);
    rows(day.skills);
    rows(day.programs);
  });
  rows(fold.contentHashes);
  rows(fold.statistics.rows, ({ nodeIds, ...span }) => { write(span); rows(nodeIds); });
  rows(fold.nodes);
  rows(fold.events);
  rows(fold.files);
  rows(fold.toolEpochs, ({ nodeIds, ...epoch }) => { write(epoch); rows(nodeIds); });
  rows(fold.commands, ({ outputNodes, programs, ...command }) => { write(command); rows(programs); rows(outputNodes); });
  rows(requests);
  flush();
  return hash.digest("hex");
}

function applyEntries(fold: ContextFold, entries: readonly TimelineEntry[]) {
  for (const entry of entries) fold.apply(rowOf(entry));
}

export class TimelineReader {
  private frames = new RetainedCache<Frame>(8, RESIDENT_LIMIT);
  private pending = new Map<string, Promise<Frame>>();
  private lifetime = new AbortController();
  private signal = this.lifetime.signal;
  private stop = () => this.lifetime.abort();

  constructor(private owner: AbortSignal, private budget = sessionReadBudget) {
    if (owner.aborted) this.stop();
    else owner.addEventListener("abort", this.stop, { once: true });
  }

  async read(id: string, paseo: PaseoApi) {
    ensureActive(this.signal);
    const active = this.pending.get(id);
    if (active) return active;
    const estimate = TIMELINE_PAGE_BYTES + (this.frames.peek(id)?.residentBytes ?? 0);
    const pending = this.budget.run(estimate, this.signal, (account) => this.fetch(id, paseo, account));
    this.pending.set(id, pending);
    try {
      const frame = await pending;
      ensureActive(this.signal);
      this.frames.set(id, frame, frame.residentBytes);
      return frame;
    } finally { if (this.pending.get(id) === pending) this.pending.delete(id); }
  }

  private async fetch(id: string, paseo: PaseoApi, account: AccountRead): Promise<Frame> {
    const timeline = paseo.agents.ref(id).timeline;
    const cached = this.frames.peek(id);
    if (cached?.cursor) {
      let bytes = 0;
      const append = await timelineAfter(timeline, cached.cursor, this.signal, (entries) => {
        bytes += sizeOf(entries);
        account(TIMELINE_PAGE_BYTES + cached.residentBytes + bytes * 2);
      });
      if (append) {
        if (!append.entries.length) { cached.cursor = append.end; return cached; }
        const last = cached.entries.at(-1)?.seqStart;
        if (last !== undefined && append.entries.some((entry) => entry.seqStart <= last)) {
          // Projected rows can be extended when a tool finishes or text is
          // merged. Rebuild from the complete entries with their new versions.
          const bySeq = new Map(cached.entries.map((entry) => [entry.seqStart, entry]));
          for (const entry of append.entries) bySeq.set(entry.seqStart, entry);
          const entries = [...bySeq.values()].sort((a, b) => a.seqStart - b.seqStart);
          return this.frame(entries, append.end.epoch, append.end, sizeOf(entries));
        }
        try {
          applyEntries(cached.fold, append.entries);
          for (const entry of append.entries) cached.entries.push(entry);
          cached.bytes += bytes;
          cached.residentBytes = cached.bytes + cached.fold.residentBytes;
        } catch (error) {
          this.frames.delete(id);
          throw error;
        }
        cached.cursor = append.end;
        return cached;
      }
    }
    const pages: Page[] = [];
    let bytes = 0;
    for await (const page of timelineHistory(timeline, this.signal)) {
      bytes += sizeOf(page.entries);
      account(TIMELINE_PAGE_BYTES + (cached?.residentBytes ?? 0) + bytes * 2);
      pages.push(page);
    }
    const tail = pages[0], entries = pages.reverse().flatMap((page) => page.entries);
    return this.frame(entries, tail?.epoch ?? "timeline", tail?.endCursor ?? null, bytes);
  }

  private frame(entries: TimelineEntry[], epoch: string, cursor: Page["endCursor"], bytes: number): Frame {
    const fold = new ContextFold("timeline", epoch);
    applyEntries(fold, entries);
    return { entries, fold, cursor, bytes, residentBytes: bytes + fold.residentBytes };
  }

  weight(frame: Frame) { return frame.residentBytes; }

  bodyReader(frame: Frame, revision = frame.fold.revision): ReadBodies {
    return async (ids, project) => {
      ensureActive(this.signal);
      if (revision !== frame.fold.revision) throw new Error("Timeline changed while reading content; refresh the session and retry");
      const lines = new Map<number, number[]>();
      let bytes = MIB;
      for (const id of new Set(ids)) {
        const node = frame.fold.nodes[id];
        if (!node) throw new Error("Context item is no longer available");
        const group = lines.get(node.line);
        if (group) group.push(id);
        else {
          lines.set(node.line, [id]);
          bytes += itemBytes(frame.entries[node.line - 1].item) * 2;
        }
      }
      const result = new Map<number, ReturnType<typeof project>>();
      if (!lines.size) return result;
      return this.budget.run(bytes, this.signal, async () => {
        if (revision !== frame.fold.revision) throw new Error("Timeline changed while reading content; refresh the session and retry");
        for (const [line, group] of lines) {
          const messages = messagesOf(rowOf(frame.entries[line - 1]), "timeline");
          for (const id of group) {
            const node = frame.fold.nodes[id];
            result.set(id, project(id, messages.find((message) => message.block === node.block)?.text ?? ""));
          }
        }
        return result;
      });
    };
  }

  clear() {
    this.owner.removeEventListener("abort", this.stop);
    this.stop();
    this.frames.clear();
    this.pending.clear();
  }
}
