import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { expect, test } from "vitest";
import { ContextFold } from "../server/fold";
import { historyPage } from "../server/history";
import { Pricing } from "../server/pricing";
import { agentOf, ContextService } from "../server/service";
import { UiRoutes } from "../server/ui-routes";
import { upstreamOf } from "../server/upstream";
import { HISTORY_PARTS, type ContextTimelineDetail, type HistoryPage, type HistoryPart, type HistoryRow } from "../shared/core/types";

const raw = { id: "history-fixture", labels: {}, provider: "codex", status: "idle" } as PaseoAgent;
const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: raw }) }) } } as unknown as PaseoApi;
class OfflinePricing extends Pricing { override async refresh() {} }

function fixture() {
  const fold = new ContextFold("codex");
  const add = (type: string, payload: unknown) => fold.apply({ type, payload, timestamp: (fold.revision + 1) * 1000 });
  add("turn_context", { turn_id: "one", model: "old" });
  add("response_item", { type: "message", role: "developer", content: [{ text: "Injection" }] });
  for (let n = 0; n < 3; n++) {
    add("response_item", { type: "function_call", name: "read_file", call_id: `read-${n}`, arguments: { path: `/file-${n}` } });
    add("response_item", { type: "function_call_output", call_id: `read-${n}`, output: "contents" });
    add("token_usage_record", { response_id: `${n}`, turn_id: "one", usage: { input_tokens: 100, output_tokens: 4 } });
  }
  add("event_msg", { type: "thread_settings_applied", model: "new" });
  add("compacted", { message: "Summary" });
  add("response_item", { type: "message", role: "user", content: [{ text: "Continue" }] });
  return fold;
}

test("all seven history routes page through the same full projection as detail and facts", async () => {
  const fold = fixture(), entry = { fold };
  const service = new ContextService({ read: async () => ({ entry }), locate: async () => null,
    content: async () => "", clear() {} }, new OfflinePricing());
  const routes = new UiRoutes(service);
  const input = { sessionId: raw.id };
  const read = <T>(route: string, extra = {}) =>
    routes.rpc(`api/paseo-context/${route}`, { ...input, ...extra }, paseo) as Promise<{ ok: true; value: T }>;
  try {
    const { value: detail } = await read<ContextTimelineDetail>("detail");
    const { value: facts } = await read<{ rev: number; live: boolean; parts: { events: HistoryRow[] } }>("facts", { parts: ["events"] });
    expect(facts.rev).toBe(detail.rev);
    expect(facts.live).toBe(true);
    expect(facts.parts.events).toEqual(detail.events);
    const expected: Record<HistoryPart, HistoryRow[]> = {
      requests: detail.requests, events: detail.events, milestones: detail.events.filter((row) => row.kind === "compaction" || row.kind === "model"),
      nodes: detail.nodes, archive: detail.archive, files: detail.fileOps!, spans: detail.spans!,
    };
    for (const part of HISTORY_PARTS) {
      const rows = expected[part];
      expect(rows.length).toBeGreaterThan(1);
      const first = await read<HistoryPage>("history", { part, limit: 1 });
      expect(first).toEqual({ ok: true, value: expect.objectContaining({
        rev: detail.rev, live: facts.live, part, atEnd: true, atStart: false, total: rows.length, last: rows.length - 1,
      }) });
      const pages = [first.value];
      while (!pages.at(-1)!.atStart) {
        const previous = pages.at(-1)!;
        const cursor = previous.beforeSeq === undefined ? { beforeIndex: previous.beforeIndex } : { beforeSeq: previous.beforeSeq };
        expect(Object.values(cursor)[0]).toBeDefined();
        const { value } = await read<HistoryPage>("history", { part, limit: 1, ...cursor });
        expect(value.last + 1).toBe(previous.first);
        expect(value.atEnd).toBe(false);
        pages.push(value);
      }
      expect(pages.reverse().flatMap((page) => page.rows)).toEqual(rows);
    }
    await expect(read("history", { part: "commands" })).rejects.toThrow("Invalid context history part");
  } finally {
    routes.clear();
    service.clear();
  }
});

test("sequence pages keep same-sequence rows together, including non-milestone events at that sequence", () => {
  const fold = fixture(), agent = agentOf(raw);
  const { head } = upstreamOf({ fold, agent, summary: fold.summary(agent), requests: fold.requests, revision: 12 });
  const events = head.events;
  const seq = events.at(-1)!.seq;
  expect(events.slice(-2).map((row) => row.seq)).toEqual([seq, seq]);
  const tail = historyPage(head, "events", { limit: 1 });
  expect(tail).toMatchObject({ first: events.length - 2, last: events.length - 1, beforeSeq: seq, rows: events.slice(-2) });
  expect(historyPage(head, "events", { beforeSeq: seq })).toMatchObject({ rows: events.slice(0, -2), atStart: true, atEnd: false });
  expect(historyPage(head, "milestones", { limit: 1 })).toMatchObject({ rows: [events.at(-2)] });
  const request = head.requests.at(-1)!;
  head.requests.push({ ...request, output: 99 });
  expect(historyPage(head, "requests", { limit: 1 }).rows).toEqual([request, head.requests.at(-1)]);
});

test("applies per-part defaults and finite limit and cursor bounds", () => {
  const fold = fixture(), agent = agentOf(raw);
  const { head } = upstreamOf({ fold, agent, summary: fold.summary(agent), requests: fold.requests, revision: 4 });
  const many = <T>(row: T) => Array.from({ length: 1002 }, () => ({ ...row }));
  head.requests = many(head.requests[0]).map((row, seq) => ({ ...row, seq }));
  head.events = many(head.events.find((row) => row.kind === "model")!).map((row, seq) => ({ ...row, seq }));
  head.nodes = many(head.nodes[0]);
  head.archive = many(head.archive[0]);
  head.fileOps = many(head.fileOps![0]);
  head.spans = many(head.spans![0]);
  const defaults = [400, 400, 400, 200, 200, 200, 1000];
  for (const [i, part] of HISTORY_PARTS.entries()) {
    expect(historyPage(head, part, {}).rows).toHaveLength(defaults[i]);
    expect(historyPage(head, part, { limit: Infinity }).rows).toHaveLength(defaults[i]);
    expect(historyPage(head, part, { limit: -50 }).rows).toHaveLength(1);
    expect(historyPage(head, part, { limit: 2.8 }).rows).toHaveLength(2);
    expect(historyPage(head, part, { limit: 5000 }).rows).toHaveLength(1000);
    expect(historyPage(head, part, { beforeSeq: 0, beforeIndex: 0 })).toMatchObject({
      rows: [], first: 0, last: -1, atStart: true, atEnd: false, total: 1002,
    });
    expect(historyPage(head, part, { beforeSeq: 20_000, beforeIndex: 20_000 }).atEnd).toBe(true);
    expect(historyPage(head, part, { beforeSeq: -1, beforeIndex: 1.5 }).atEnd).toBe(true);
  }
  expect(historyPage({ ...head, archive: [] }, "archive", {})).toEqual({
    rev: 4, live: true, part: "archive", rows: [], first: 0, last: -1, total: 0, atStart: true, atEnd: true,
  });
});
