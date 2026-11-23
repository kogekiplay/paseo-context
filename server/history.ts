import { HISTORY_PARTS, type ContextTimeline, type HistoryPage, type HistoryPart, type HistoryRow } from "../shared/core/types";
import { milestoneKindOf } from "../shared/core/milestones";
import type { RecordValue } from "./value";

const parts: ReadonlySet<string> = new Set(HISTORY_PARTS);
const limits: Record<HistoryPart, number> = {
  requests: 400, events: 400, milestones: 400, nodes: 200, archive: 200, files: 200, spans: 1000,
};
const milestones = new WeakMap<ContextTimeline["events"], ContextTimeline["events"]>();

export function historyPart(value: unknown): HistoryPart {
  if (typeof value !== "string" || !parts.has(value)) throw new Error("Invalid context history part");
  return value as HistoryPart;
}

function cursorOf(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function lowerBound(rows: readonly { seq: number }[], seq: number) {
  let low = 0, high = rows.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (rows[mid].seq < seq) low = mid + 1;
    else high = mid;
  }
  return low;
}

type PageSlice = Omit<HistoryPage, "rev" | "live" | "part">;
function pageBySeq(rows: readonly Extract<HistoryRow, { seq: number }>[], body: RecordValue, limit: number): PageSlice {
  const before = cursorOf(body.beforeSeq);
  const end = before === undefined ? rows.length : lowerBound(rows, before);
  let start = Math.max(0, end - limit);
  while (start > 0 && rows[start - 1].seq === rows[start].seq) start--;
  return { ...slice(rows, start, end), ...(start > 0 ? { beforeSeq: rows[start].seq } : {}) };
}

function pageByIndex(rows: readonly HistoryRow[], body: RecordValue, limit: number): PageSlice {
  const end = Math.min(cursorOf(body.beforeIndex) ?? rows.length, rows.length);
  const start = Math.max(0, end - limit);
  return { ...slice(rows, start, end), ...(start > 0 ? { beforeIndex: start } : {}) };
}

function slice(rows: readonly HistoryRow[], start: number, end: number): PageSlice {
  return {
    rows: rows.slice(start, end), first: start, last: end - 1,
    total: rows.length, atStart: start === 0, atEnd: end === rows.length,
  };
}

function milestoneRows(events: ContextTimeline["events"]) {
  let rows = milestones.get(events);
  if (!rows) {
    rows = events.filter((event) => milestoneKindOf(event) !== null);
    milestones.set(events, rows);
  }
  return rows;
}

export function historyPage(head: ContextTimeline, part: HistoryPart, body: RecordValue): HistoryPage {
  const limit = typeof body.limit === "number" && Number.isFinite(body.limit)
    ? Math.min(1000, Math.max(1, Math.floor(body.limit))) : limits[part];
  const page = part === "requests" ? pageBySeq(head.requests, body, limit)
    : part === "events" ? pageBySeq(head.events, body, limit)
    : part === "milestones" ? pageBySeq(milestoneRows(head.events), body, limit)
    : pageByIndex(part === "files" ? head.fileOps ?? [] : part === "spans" ? head.spans ?? [] : head[part], body, limit);
  // Like facts.live, this identifies the revisioned Paseo projection.
  // Whether the agent is running is a separate field on its directory row.
  return { rev: head.detailRev ?? 0, live: true, part, ...page };
}
