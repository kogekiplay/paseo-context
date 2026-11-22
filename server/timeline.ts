import type { PaseoApi } from "@getpaseo/client";
import { ContextFold } from "./fold";
import { messagesOf } from "./normalize";
import { ensureActive, timelineAfter, timelineHistory } from "./paging";
import type { ReadBodies } from "./reader";
import { record } from "./value";

type Page = Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>;
type TimelineEntry = Page["entries"][number];
interface Frame {
  fold: ContextFold;
  entries: TimelineEntry[];
  cursor: Page["endCursor"];
  bytes: number;
  residentBytes: number;
  at: number;
}
const RESIDENT_LIMIT = 48 * 1024 * 1024;
const RETAIN_MS = 120_000;
const rowOf = (entry: TimelineEntry) => ({ ...record(entry.item), timestamp: entry.timestamp });
const sizeOf = (entries: readonly TimelineEntry[]) => entries.reduce((size, entry) =>
  size + JSON.stringify(entry.item).length * 2 + 128, 0);

function applyEntries(fold: ContextFold, entries: readonly TimelineEntry[]) {
  for (const entry of entries) fold.apply(rowOf(entry));
}

export class TimelineReader {
  private frames = new Map<string, Frame>();
  private pending = new Map<string, Promise<Frame>>();

  constructor(private signal: AbortSignal) {}

  async read(id: string, paseo: PaseoApi) {
    ensureActive(this.signal);
    const active = this.pending.get(id);
    if (active) return active;
    const pending = this.fetch(id, paseo);
    this.pending.set(id, pending);
    try {
      const frame = await pending;
      ensureActive(this.signal);
      this.remember(id, frame);
      return frame;
    } finally { if (this.pending.get(id) === pending) this.pending.delete(id); }
  }

  private async fetch(id: string, paseo: PaseoApi): Promise<Frame> {
    const timeline = paseo.agents.ref(id).timeline;
    const cached = this.frames.get(id);
    if (cached?.cursor) {
      const append = await timelineAfter(timeline, cached.cursor, this.signal);
      if (append) {
        if (!append.entries.length) { cached.cursor = append.end; return cached; }
        const last = cached.entries.at(-1)?.seqStart;
        if (last !== undefined && append.entries.some((entry) => entry.seqStart <= last)) {
          // Projected rows can be extended when a tool finishes or text is
          // merged. Rebuild from the complete entries with their new versions.
          const bySeq = new Map(cached.entries.map((entry) => [entry.seqStart, entry]));
          for (const entry of append.entries) bySeq.set(entry.seqStart, entry);
          const entries = [...bySeq.values()].sort((a, b) => a.seqStart - b.seqStart);
          return this.frame(entries, append.end.epoch, append.end);
        }
        try {
          const bytes = sizeOf(append.entries);
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
    for await (const page of timelineHistory(timeline, this.signal)) pages.push(page);
    const tail = pages[0], entries = pages.reverse().flatMap((page) => page.entries);
    return this.frame(entries, tail?.epoch ?? "timeline", tail?.endCursor ?? null);
  }

  private frame(entries: TimelineEntry[], epoch: string, cursor: Page["endCursor"]): Frame {
    const fold = new ContextFold("timeline", epoch);
    applyEntries(fold, entries);
    const bytes = sizeOf(entries);
    return { entries, fold, cursor, bytes, residentBytes: bytes + fold.residentBytes, at: 0 };
  }

  private remember(id: string, frame: Frame) {
    frame.at = Date.now();
    this.frames.delete(id);
    if (frame.residentBytes > RESIDENT_LIMIT) return;
    this.frames.set(id, frame);
    let weight = [...this.frames.values()].reduce((size, value) => size + value.residentBytes, 0);
    for (const [key, value] of this.frames) {
      if (this.frames.size <= 8 && weight <= RESIDENT_LIMIT && Date.now() - value.at < RETAIN_MS) break;
      this.frames.delete(key);
      weight -= value.residentBytes;
    }
  }

  weight(frame: Frame) { return frame.residentBytes; }

  bodyReader(frame: Frame, revision = frame.fold.revision): ReadBodies {
    return async (ids, project) => {
      ensureActive(this.signal);
      if (revision !== frame.fold.revision) throw new Error("Timeline changed while reading content; refresh the session and retry");
      const parsed = new Map<number, ReturnType<typeof messagesOf>>();
      const result = new Map<number, ReturnType<typeof project>>();
      for (const id of new Set(ids)) {
        const node = frame.fold.nodes[id];
        if (!node) throw new Error("Context item is no longer available");
        let messages = parsed.get(node.line);
        if (!messages) {
          messages = messagesOf(rowOf(frame.entries[node.line - 1]), "timeline");
          parsed.set(node.line, messages);
        }
        result.set(id, project(id, messages.find((message) => message.block === node.block)?.text ?? ""));
      }
      return result;
    };
  }

  clear() { this.frames.clear(); this.pending.clear(); }
}
