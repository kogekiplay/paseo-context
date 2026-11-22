import type { PaseoApi } from "@getpaseo/client";

type AgentTimeline = ReturnType<PaseoApi["agents"]["ref"]>["timeline"];
type TimelinePage = Awaited<ReturnType<AgentTimeline["refetch"]>>;
type TimelineCursor = NonNullable<TimelinePage["startCursor"]>;

export function ensureActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Plugin was stopped");
}

export function nextCursor<T>(more: boolean, cursor: T | null | undefined, seen: Set<string>, source: string): T | undefined {
  if (!more) return undefined;
  if (cursor === null || cursor === undefined || cursor === "") throw new Error(`${source} omitted its history cursor`);
  const key = JSON.stringify(cursor);
  if (seen.has(key)) throw new Error(`${source} returned a repeated cursor`);
  seen.add(key);
  return cursor;
}

async function readPage(timeline: AgentTimeline, direction: "tail" | "before" | "after", cursor: TimelineCursor | undefined, signal: AbortSignal) {
  ensureActive(signal);
  const page = await timeline.refetch({ direction, limit: 200, ...(cursor ? { cursor } : {}) });
  ensureActive(signal);
  if (page.error) throw new Error(page.error);
  return page;
}

export async function* timelineHistory(timeline: AgentTimeline, signal: AbortSignal) {
  const seen = new Set<string>();
  let cursor: TimelineCursor | undefined;
  let epoch: string | undefined;
  do {
    const page = await readPage(timeline, cursor ? "before" : "tail", cursor, signal);
    if (page.gap || page.staleCursor || cursor && page.reset || epoch !== undefined && page.epoch !== epoch) {
      throw new Error("Timeline changed or has a gap while reading history");
    }
    epoch = page.epoch;
    cursor = nextCursor(page.hasOlder, page.startCursor, seen, "Timeline");
    yield page;
  } while (cursor);
}

export async function timelineAfter(timeline: AgentTimeline, start: TimelineCursor, signal: AbortSignal,
  onPage: (entries: TimelinePage["entries"]) => void) {
  const entries: TimelinePage["entries"] = [];
  const seen = new Set<string>([JSON.stringify(start)]);
  let cursor: TimelineCursor | undefined = start;
  let end = start;
  do {
    const page = await readPage(timeline, "after", cursor, signal);
    if (page.reset || page.staleCursor || page.gap || page.epoch !== start.epoch) return null;
    const next = nextCursor(page.hasNewer, page.endCursor, seen, "Timeline");
    if (page.endCursor) {
      if (page.endCursor.epoch !== start.epoch || page.endCursor.seq < end.seq || page.entries.length && page.endCursor.seq === end.seq) {
        throw new Error("Timeline returned a non-advancing cursor");
      }
      end = page.endCursor;
    } else if (page.entries.length) throw new Error("Timeline omitted its end cursor for new entries");
    onPage(page.entries);
    entries.push(...page.entries);
    cursor = next;
  } while (cursor);
  return { entries, end };
}
