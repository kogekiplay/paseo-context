import { expect, test } from "vitest";
import { ContextFold } from "../server/fold";
import { statisticsOf } from "../server/statistics";
import type { Agent } from "../shared/contracts";
import { statisticsDetails } from "../server/statistics-details";
import { ContextService } from "../server/service";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { aggregateTotals, aggregateTurn } from "../shared/core/stats-aggregate";

const agent: Agent = { id: "root", workspaceId: "work", parentId: null, title: "Fixture", cwd: "/project",
  provider: "codex", model: "test", sessionId: null, createdAt: 1000, updatedAt: 9000, running: false, archived: false };
const row = (type: string, payload: unknown, at: number) => ({ type, payload, timestamp: new Date(at).toISOString() });
const dataOf = (fold: ContextFold) => ({ agent, fold, requests: fold.requests, summary: fold.summary(agent), revision: fold.revision });
test("the original statistics model keeps turns and steps stable, preserves zero and leaves unreported timing unknown", () => {
  const fold = new ContextFold("codex");
  for (const [turn, time] of [["one", 1000], ["two", 6000]] as const) {
    fold.apply(row("turn_context", { turn_id: turn }, time));
    fold.apply(row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: turn }] }, time));
    fold.apply(row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }, time + 1000));
    fold.apply(row("token_usage_record", { response_id: turn, usage: { input_tokens: 0, output_tokens: 0 } }, time + 2000));
  }
  const snapshot = statisticsOf(dataOf(fold));
  expect(snapshot.stepCount).toBe(2);
  expect(snapshot.turns.map((turn) => [turn.turn, turn.prompt, turn.steps[0].step])).toEqual([[1, "one", 1], [2, "two", 1]]);
  expect(snapshot.turns[0].steps[0]).toMatchObject({ context: 0, output: 0, ttft: null, decode: null, tps: null });
  expect(snapshot.turns[0].steps[0]).toMatchObject({ cacheRead: null, cacheWrite: null });
  const missing = dataOf(fold); missing.summary.notices.push("usage-unavailable");
  expect(statisticsOf(missing).turns[0].steps[0]).toMatchObject({ context: null, output: null, cacheRead: null, cacheHit: null });
});
test("parallel captured calls keep summed work separate from elapsed tool time and retain errors", () => {
  const fold = new ContextFold("codex");
  for (const callId of ["a", "b"]) fold.apply(row("response_item",
    { type: "function_call", name: "exec_command", arguments: '{"cmd":"fixture"}', call_id: callId }, 1000));
  fold.apply(row("response_item", { type: "function_call_output", call_id: "a", output: "Process exited with code 0" }, 2000));
  fold.apply(row("response_item", { type: "function_call_output", call_id: "b", output: "Process exited with code 1" }, 2000));
  fold.apply(row("token_usage_record", { response_id: "one", usage: { input_tokens: 100, output_tokens: 10 } }, 3000));
  const step = statisticsOf(dataOf(fold)).turns[0].steps[0];
  expect(step.tool).toBe(2000);
  expect(step.toolWall).toBe(1000);
  expect(step.tools).toEqual([{ name: "exec_command", count: 2 }]);
  expect(step.toolErrors).toBe(1);
  expect(step.calls.map((call) => call.error)).toEqual([false, true]);
});
test("expanding one statistics row loads captured bodies within the original detail budget", async () => {
  const fold = new ContextFold("codex");
  const content = new Map<number, string>();
  for (let index = 0; index < 13; index++) {
    const id = `call-${index}`;
    content.set(fold.nodes.length, '{"cmd":"fixture"}');
    fold.apply(row("response_item", { type: "function_call", name: "exec_command", arguments: '{"cmd":"fixture"}', call_id: id }, 1000));
    content.set(fold.nodes.length, "body\n".repeat(20000));
    fold.apply(row("response_item", { type: "function_call_output", call_id: id, output: content.get(fold.nodes.length) }, 2000));
  }
  fold.apply(row("token_usage_record", { response_id: "one", usage: { input_tokens: 100, output_tokens: 10 } }, 3000));
  const read = (async (_agentId: string, nodeId: number) => content.get(nodeId) ?? "") as ContextService["content"];
  const detail = await statisticsDetails(dataOf(fold), "one", read, {} as PaseoApi);
  const step = statisticsOf(dataOf(fold)).turns[0].steps[0];
  expect(step.calls).toHaveLength(12);
  expect(step.tools).toEqual([{ name: "exec_command", count: 13 }]);
  expect(detail.calls).toHaveLength(12);
  expect(detail.calls.reduce((n, call) => n + (call.text?.length ?? 0), 0)).toBe(48000);
  expect(detail.calls.every((call) => call.truncated && call.chars === 100000)).toBe(true);
  await expect(statisticsDetails(dataOf(fold), "missing", read, {} as PaseoApi)).rejects.toThrow("no longer available");
});
test("a new turn without usage retains its own tools, interruption and details boundary", async () => {
  const fold = new ContextFold("codex");
  fold.apply(row("turn_context", { turn_id: "one" }, 1000));
  fold.apply(row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "old answer" }] }, 2000));
  fold.apply(row("token_usage_record", { response_id: "one", usage: { input_tokens: 100, output_tokens: 10 } }, 3000));
  fold.apply(row("turn_context", { turn_id: "two" }, 4000));
  fold.apply(row("response_item", { type: "function_call", name: "exec_command", arguments: '{"cmd":"new"}', call_id: "new" }, 5000));
  let data = dataOf(fold); data.summary.agent = { ...agent, running: true };
  let snapshot = statisticsOf(data);
  expect(snapshot.stepCount).toBe(2);
  expect(snapshot.turns[0].steps[0].tools).toEqual([]);
  expect(snapshot.turns[1].steps[0]).toMatchObject({ context: null, output: null, running: true, tools: [{ name: "exec_command", count: 1 }] });
  fold.apply(row("event_msg", { type: "turn_aborted" }, 6000));
  snapshot = statisticsOf(dataOf(fold));
  expect(snapshot.turns[1].steps[0]).toMatchObject({ running: false, aborted: true });
  const read = (async () => '{"cmd":"new"}') as ContextService["content"];
  const old = await statisticsDetails(dataOf(fold), snapshot.turns[0].steps[0].sourceId!, read, {} as PaseoApi);
  expect(old.calls).toEqual([]);
});
test("details revision changes when a late tool result arrives, without changing step identity", () => {
  const fold = new ContextFold("claude");
  fold.apply({ type: "user", uuid: "u", timestamp: new Date(1000).toISOString(), message: { content: "test" } });
  fold.apply({ type: "assistant", timestamp: new Date(2000).toISOString(), message: {
    id: "m", content: [{ type: "tool_use", id: "c", name: "Read", input: { file_path: "a" } }],
    usage: { input_tokens: 50, output_tokens: 5 },
  } });
  const before = statisticsOf(dataOf(fold)).turns[0].steps[0];
  fold.apply({ type: "user", timestamp: new Date(3000).toISOString(), message: {
    content: [{ type: "tool_result", tool_use_id: "c", content: "complete" }],
  } });
  const after = statisticsOf(dataOf(fold)).turns[0].steps[0];
  expect(after.sourceId).toBe(before.sourceId);
  expect(after.contentRevision).not.toBe(before.contentRevision);
  expect(after.calls[0].ms).toBe(1000);
});
test("CC Switch boundary rules exclude tools flushed before usage from model latency", () => {
  for (const usageType of ["modern", "legacy"]) {
    const fold = new ContextFold("codex");
    fold.apply(row("turn_context", { turn_id: "one" }, 1000));
    fold.apply(row("response_item", { type: "function_call", name: "exec_command", arguments: "{}", call_id: "c" }, 2000));
    fold.apply(row("response_item", { type: "function_call_output", call_id: "c", output: "done" }, 5000));
    const usage = { input_tokens: 100, output_tokens: 10 };
    fold.apply(usageType === "modern" ? row("token_usage_record", { response_id: "one", usage }, 6000)
      : row("event_msg", { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } }, 6000));
    const step = statisticsOf(dataOf(fold)).turns[0].steps[0];
    expect(step).toMatchObject({ model: 1000, tool: 3000, ttft: null, decode: null, timingSource: "session-estimate" });
  }
});
test("Codex exact per-request usage and cache aliases survive independently advancing cumulative counters", () => {
  const fold = new ContextFold("codex");
  const token = (total: number, last: number) => row("event_msg", { type: "token_count", info: {
    total_token_usage: { input_tokens: total, output_tokens: total / 10 },
    last_token_usage: { input_tokens: last, output_tokens: 10, cache_read_input_tokens: 0 },
  } }, total);
  fold.apply(token(1000, 100)); fold.apply(token(2000, 200)); fold.apply(token(2000, 200));
  expect(fold.requests.map((request) => request.usage.input)).toEqual([100, 200]);
  expect(fold.summary(agent).usage.input).toBe(300);
  expect(statisticsOf(dataOf(fold)).turns[0].steps[0]).toMatchObject({ cacheRead: 0, cacheWrite: null });
});
test("first-token estimates need recorded output starts and reject a partial first Claude block", () => {
  const fold = new ContextFold("codex");
  fold.apply(row("turn_context", { turn_id: "one" }, 1000));
  fold.apply(row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }, 4000));
  fold.apply(row("event_msg", { type: "item_completed", item: { type: "AgentMessage" }, started_at_ms: 2000 }, 4000));
  fold.apply(row("token_usage_record", { response_id: "one", usage: { input_tokens: 100, output_tokens: 10 } }, 4000));
  expect(statisticsOf(dataOf(fold)).turns[0].steps[0]).toMatchObject({ model: 3000, ttft: 1000, decode: 2000, tps: 5 });
  const claude = new ContextFold("claude");
  claude.apply({ type: "user", uuid: "u", timestamp: new Date(1000).toISOString(), message: { content: "test" } });
  claude.apply({ type: "assistant", apiBlockIndex: 1, timestamp: new Date(4000).toISOString(), message: {
    id: "m", content: [{ type: "text", text: "partial" }], usage: { input_tokens: 10, output_tokens: 10 },
  } });
  expect(statisticsOf(dataOf(claude)).turns[0].steps[0]).toMatchObject({ model: null, ttft: null });
});
test("answer detail reports truncation at an exact budget boundary with later content", async () => {
  const fold = new ContextFold("codex");
  for (const text of ["a".repeat(16000), "later"]) fold.apply(row("response_item", {
    type: "message", role: "assistant", content: [{ type: "output_text", text }],
  }, 1000));
  fold.apply(row("token_usage_record", { response_id: "one", usage: { input_tokens: 10, output_tokens: 10 } }, 2000));
  const read = (async (_agentId: string, id: number) => id === 0 ? "a".repeat(16000) : "later") as ContextService["content"];
  expect(await statisticsDetails(dataOf(fold), "one", read, {} as PaseoApi)).toMatchObject({
    answerTruncated: true, answerBody: "a".repeat(16000),
  });
});
test("a nonadjacent duplicate usage record updates its original step without adding billed output", () => {
  const fold = new ContextFold("codex");
  const usage = (id: string, at: number) => row("token_usage_record", { response_id: id, usage: { input_tokens: 100, output_tokens: 10 } }, at);
  for (const [id, at] of [["a", 1000], ["b", 4000]] as const) {
    fold.apply(row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: id }] }, at));
    fold.apply(usage(id, at + 1000));
  }
  fold.apply(usage("a", 8000));
  const snapshot = statisticsOf(dataOf(fold));
  expect(snapshot.stepCount).toBe(2);
  expect(aggregateTotals(snapshot.turns).output).toBe(20);
  expect(fold.summary(agent).usage.output).toBe(20);
});
test("legacy explicitly reported zero is retained and duplicate snapshots add no steps", () => {
  const fold = new ContextFold("codex");
  const zero = row("event_msg", { type: "token_count", info: {
    total_token_usage: { input_tokens: 0, output_tokens: 0 },
    last_token_usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
  } }, 3000);
  fold.apply(row("turn_context", { turn_id: "one" }, 1000));
  fold.apply(row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }, 2000));
  fold.apply(zero); fold.apply(zero);
  const snapshot = statisticsOf(dataOf(fold));
  expect(snapshot.stepCount).toBe(1);
  expect(snapshot.turns[0].steps[0]).toMatchObject({ context: 0, output: 0, cacheRead: 0, cacheWrite: null });
  expect(fold.requests).toHaveLength(1);
});
test("cache provenance and speed coverage survive turn and session aggregation", () => {
  const fold = new ContextFold("codex");
  fold.apply(row("token_usage_record", { response_id: "one", usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0 } }, 2000));
  const step = statisticsOf(dataOf(fold)).turns[0].steps[0];
  for (const cacheWrite of [null, 0, 10]) {
    const known = { ...step, decode: 1000, cacheWrite };
    const unknown = { ...step, output: 100, decode: null, cacheRead: null, cacheWrite };
    const turn = aggregateTurn(1, [known, unknown]);
    const totals = aggregateTotals([turn]);
    expect(turn.cacheWrite).toBe(cacheWrite === null ? null : cacheWrite * 2);
    expect(totals.cacheWrite).toBe(turn.cacheWrite);
    expect(turn.tps).toBe(10); expect(totals.tps).toBe(10);
    expect(totals.output).toBe(110);
  }
  const writeOnly = aggregateTurn(1, [{ ...step, cacheRead: null, cacheWrite: 5 }]);
  expect(writeOnly).toMatchObject({ cacheWrite: 5, cacheRead: null, cacheHit: null });
  expect(aggregateTotals([writeOnly])).toMatchObject({ cacheWrite: 5, cacheRead: null, cacheHit: null });
});
test("timeline summary and separate detail loads use a stable epoch and do not invent interruptions", async () => {
  const service = new ContextService();
  const raw = { id: agent.id, provider: "other", status: "idle", labels: {}, title: "Timeline fixture",
    cwd: "/project", createdAt: new Date(1000).toISOString(), updatedAt: new Date(4000).toISOString() } as PaseoAgent;
  const entries = [
    { type: "user_message", text: "first" }, { type: "assistant_message", text: "answer one" },
    { type: "user_message", text: "second" }, { type: "assistant_message", text: "answer two" },
  ].map((item, index) => ({ item, timestamp: new Date((index + 1) * 1000).toISOString() }));
  const paseo = { agents: { ref: () => ({
    refresh: async () => ({ agent: raw }),
    timeline: { refetch: async () => ({ epoch: "stable", entries, hasOlder: false }) },
  }) } } as unknown as PaseoApi;
  try {
    const snapshot = statisticsOf(await service.load(raw, paseo));
    const step = snapshot.turns[0].steps[0];
    const detail = await statisticsDetails(await service.load(raw, paseo), step.sourceId!, service.content.bind(service), paseo);
    expect(detail.contentRevision).toBe(step.contentRevision);
    expect(detail.answerBody).toBe("answer one");
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.turns.flatMap((turn) => turn.steps).every((row) => !row.interrupted && !row.aborted)).toBe(true);
    entries[1].item.text = "x".repeat(200) + "a";
    const before = statisticsOf(await service.load(raw, paseo)).turns[0].steps[0];
    entries[1].item.text = "x".repeat(200) + "b";
    const changed = await service.load(raw, paseo);
    const after = statisticsOf(changed).turns[0].steps[0];
    expect(after.contentRevision).not.toBe(before.contentRevision);
    expect((await statisticsDetails(changed, after.sourceId!, service.content.bind(service), paseo)).answerBody).toBe(entries[1].item.text);
  } finally { service.clear(); }
});
