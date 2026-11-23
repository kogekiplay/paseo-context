import { describe, expect, test } from "vitest";
import type { ContextEventRecord, HistoryPage, SurfaceNode } from "../src/shared/types";
import { loadHistoryTailIndex, loadTailHistory } from "../src/client/historyPaging";
import type { HistoryFetcher } from "../src/client/timelineWire";

function pageOf<T extends ContextEventRecord | SurfaceNode>(
  part: "events" | "nodes",
  rows: T[],
  overrides: Partial<HistoryPage> = {},
): HistoryPage {
  return {
    rev: 2,
    live: true,
    part,
    rows,
    first: 0,
    last: rows.length - 1,
    total: rows.length,
    atStart: true,
    atEnd: true,
    ...overrides,
  };
}

describe("src/client/historyPaging retraction and rewrite handling", () => {
  test("loadTailHistory discards retracted agent events when server returns total=0 atStart=true", async () => {
    const old: ContextEventRecord[] = [
      { seq: 5, time: 1000, kind: "agent", name: "worker-1", detail: "running" },
    ];
    const fetcher: HistoryFetcher = async () => pageOf("events", [], { total: 0, first: 0, last: -1, atStart: true });
    const result = await loadTailHistory<ContextEventRecord>(fetcher, "events", old, { rev: 2, cancelled: () => false });
    expect(result).toEqual([]);
  });

  test("loadTailHistory replaces stale rows when full history fits in one atStart page (even if length matches or shrinks)", async () => {
    const old: ContextEventRecord[] = [
      { seq: 2, time: 1000, kind: "agent", name: "stale-worker" },
      { seq: 4, time: 2000, kind: "compaction", count: 1 },
    ];
    const next: ContextEventRecord[] = [
      { seq: 4, time: 2000, kind: "compaction", count: 1 },
      { seq: 6, time: 3000, kind: "prune" },
    ];
    const fetcher: HistoryFetcher = async () => pageOf("events", next, { total: 2, first: 0, atStart: true });
    const result = await loadTailHistory<ContextEventRecord>(fetcher, "events", old, { rev: 2, cancelled: () => false });
    expect(result).toEqual(next);
  });

  test("loadTailHistory falls back to full loadAllHistory when multi-page collection shrinks or shifts prefix", async () => {
    const old: ContextEventRecord[] = [
      { seq: 1, time: 100, kind: "agent", name: "retracted" },
      { seq: 2, time: 200, kind: "inject" },
      { seq: 3, time: 300, kind: "prune" },
    ];
    const serverRows: ContextEventRecord[] = [
      { seq: 2, time: 200, kind: "inject" },
      { seq: 3, time: 300, kind: "prune" },
    ];
    const calls: Array<{ beforeSeq?: number }> = [];
    const fetcher: HistoryFetcher = async (_part, cursor) => {
      calls.push({ beforeSeq: cursor?.beforeSeq });
      // Tail page does not reach start and reports shrunk total=2 < old.length=3.
      if (cursor?.beforeSeq === undefined) {
        return pageOf("events", [serverRows[1]], {
          first: 1,
          last: 1,
          total: 2,
          atStart: false,
          beforeSeq: 3,
        });
      }
      return pageOf("events", [serverRows[0]], {
        first: 0,
        last: 0,
        total: 2,
        atStart: true,
      });
    };
    const result = await loadTailHistory<ContextEventRecord>(fetcher, "events", old, { rev: 2, cancelled: () => false });
    expect(result).toEqual(serverRows);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test("loadHistoryTailIndex returns authoritative rows on atStart even when total equals old.length", async () => {
    const old: SurfaceNode[] = [
      { seq: 1, cat: "assistant", tokens: 10, text: "running" },
    ];
    const rewritten: SurfaceNode[] = [
      { seq: 1, cat: "assistant", tokens: 20, text: "failed" },
    ];
    const fetcher: HistoryFetcher = async () => pageOf("nodes", rewritten, { total: 1, first: 0, atStart: true });
    const result = await loadHistoryTailIndex<SurfaceNode>(fetcher, "nodes", old, { rev: 2, cancelled: () => false });
    expect(result).toEqual(rewritten);
  });
});
