import { describe, expect, test } from "vitest";
import { ContextFold } from "../server/fold";
import { Pricing } from "../server/pricing";
import { aggregate } from "../server/service";
import { statisticsOf } from "../server/statistics";
import { upstreamOf, type Loaded } from "../server/upstream";
import { scopeSchema, type Agent } from "../shared/contracts";
import { reportedUsageOf } from "../shared/usage";

const agent: Agent = { id: "a", workspaceId: null, parentId: null, title: "Fixture", cwd: "/fixture",
  provider: "codex", model: "sample", sessionId: null, archived: false, running: false, createdAt: 1000, updatedAt: 9000 };
const row = (type: string, payload: unknown, at: number) => ({ type, payload, timestamp: new Date(at).toISOString() });
const respond = (role: string, text: string, at: number) => row("response_item", {
  type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }],
}, at);
const usage = (id: string, values: unknown, at: number) => row("token_usage_record", { response_id: id, usage: values }, at);
const dataOf = (fold: ContextFold): Loaded => ({ agent, fold, requests: fold.requests, summary: fold.summary(agent), revision: fold.revision });

describe("provider usage accounting", () => {
  test("applies Codex corrections once without discarding lanes or replacing the latest pressure with an older response", () => {
    const fold = new ContextFold("codex");
    fold.apply(usage("first", { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }, 1000));
    fold.apply(usage("first", { input_tokens: 120, output_tokens: 15 }, 2000));
    expect(fold.summary(agent)).toMatchObject({ contextTokens: 120, steps: 1, usage: { input: 120, cacheRead: 40, output: 15 } });
    fold.apply(usage("second", { input_tokens: 125, output_tokens: 20 }, 3000));
    fold.apply(usage("first", { output_tokens: 16 }, 4000));
    const data = dataOf(fold);
    expect(data.requests.map(({ id, usage }) => ({ id, usage }))).toMatchObject([
      { id: "first", usage: { input: 120, cacheRead: 40, output: 16 } },
      { id: "second", usage: { input: 125, output: 20 } },
    ]);
    expect(data.summary).toMatchObject({ steps: 2, contextTokens: 125, usage: { input: 245, output: 36, cacheRead: 40 } });
    expect(upstreamOf(data).head.last).toMatchObject({ prompt: 125, contextSource: "reported" });
  });

  test("merges sparse Claude usage patches and keeps explicit zero", () => {
    const fold = new ContextFold("claude");
    const write = (apiBlockIndex: number, usage: unknown, at: number) => fold.apply({ type: "assistant", apiBlockIndex,
      timestamp: new Date(at).toISOString(), message: { id: "same", content: "Answer", usage } });
    write(0, { input_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 }, 2000);
    write(1, { output_tokens: 9 }, 3000);
    expect(fold.requests[0].usage).toMatchObject({ input: 130, cacheRead: 100, cacheWrite: 10, output: 9 });
    expect(fold.summary(agent)).toMatchObject({ humanInputs: 0, contextTokens: 130, steps: 1 });
    write(2, { cache_read_input_tokens: 0 }, 4000);
    expect(fold.summary(agent)).toMatchObject({ contextTokens: 30, usage: { input: 30, cacheRead: 0, cacheWrite: 10, output: 9 } });
    expect(fold.requests[0].usageSources).toMatchObject({ input: "reported", cacheRead: "reported", cacheWrite: "reported", output: "reported" });
  });

  test("preserves cumulative provenance, derives reasoning, and leaves current pressure unreported", () => {
    const fold = new ContextFold("codex");
    fold.apply(row("event_msg", { type: "token_count", info: {
      total_token_usage: { input_tokens: 150, output_tokens: 50, reasoning_output_tokens: 30 },
    } }, 2000));
    fold.apply(row("event_msg", { type: "token_count", info: {
      total_token_usage: { input_tokens: 190, output_tokens: 64, reasoning_output_tokens: 40 },
    } }, 3000));
    const data = dataOf(fold), { head } = upstreamOf(data);
    expect(data.summary).toMatchObject({ contextTokens: null, usage: { input: 190, output: 64, reasoning: 40 } });
    expect(data.requests[1]).toMatchObject({ usage: { input: 40, output: 14, reasoning: 10 },
      usageSources: { input: "cumulative", output: "cumulative", reasoning: "cumulative" } });
    expect(head.last?.prompt).toBeUndefined();
    expect(head.requests[1]).toMatchObject({ output: 14, usageSources: { input: "cumulative" } });
    expect(head.requests[1].prompt).toBeUndefined();
    expect(statisticsOf(data).turns[0].steps[1]).toMatchObject({ context: null, output: 14, cacheRead: null });
  });

  test("preserves unknown fields across Context, Statistics and cost without discarding explicit zero", () => {
    const fold = new ContextFold("codex"), pricing = new Pricing();
    fold.apply(usage("unavailable", {}, 1000));
    fold.apply(usage("partial", { output_tokens: 0 }, 3000));
    fold.apply(usage("explicit", { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }, 5000));
    const data = dataOf(fold), { head } = upstreamOf(data);
    expect(pricing.priceRequests("codex", data.requests).map((request) => request.costUsd)).toEqual([null, null, 0]);
    expect(head.requests[1]).toMatchObject({ output: 0, usageSources: { output: "reported" } });
    expect(head.requests[1].prompt).toBeUndefined();
    expect(head.requests[1].cacheRead).toBeUndefined();
    expect(head.requests[2]).toMatchObject({ prompt: 0, output: 0, cacheRead: 0 });
    expect(reportedUsageOf(head)).toBeNull();
    expect(statisticsOf(data).turns[0].steps[1]).toMatchObject({ context: null, output: 0, cacheRead: null });
  });
});

test("recreates context from a compaction replacement without recording new activity", () => {
  const fold = new ContextFold("codex");
  const input = respond("user", "Original prompt", 1000);
  const call = row("response_item", { type: "function_call", name: "exec_command", call_id: "tool", arguments: '{"cmd":"npm test"}' }, 2000);
  const result = row("response_item", { type: "function_call_output", call_id: "tool", output: "Process exited with code 0" }, 3500);
  for (const entry of [input, call, result]) fold.apply(entry);
  fold.apply(row("compacted", { replacement_history: [input.payload, call.payload, result.payload] }, 4000));
  const data = dataOf(fold);
  expect(data.summary).toMatchObject({ humanInputs: 1, toolCalls: 1, toolMs: 1500 });
  expect(data.summary.activity[0].tools).toMatchObject([{ name: "exec_command", count: 1 }]);
  expect(fold.commands).toHaveLength(1);
  expect(fold.nodes.filter((node) => node.replayed)).toHaveLength(3);
  expect(upstreamOf(data).head.events).toMatchObject([{ kind: "compaction", count: 3, tokens: 0 }]);
});

test("attributes separate same-turn requests across midnight to their own usage dates", () => {
  const fold = new ContextFold("codex"), midnight = new Date(2026, 10, 22).getTime();
  fold.apply(respond("user", "First prompt", midnight - 5000));
  fold.apply(respond("assistant", "First answer", midnight - 3000));
  fold.apply(usage("first", { input_tokens: 100, output_tokens: 10 }, midnight - 1000));
  fold.apply(respond("assistant", "Second answer", midnight + 1000));
  fold.apply(usage("second", { input_tokens: 110, output_tokens: 15 }, midnight + 3000));
  expect(fold.requests.map(({ time, usageAt }) => [time, usageAt])).toEqual([
    [midnight - 5000, midnight - 1000], [midnight + 1000, midnight + 3000],
  ]);
  const data = dataOf(fold);
  const result = aggregate([data.summary], new Map([[agent.id, data.requests]]), scopeSchema.parse({ range: "today" }), 0, 1, 0, midnight + 5000);
  expect(result.tokens).toBe(125);
  expect(result.days.map((day) => day.tokens)).toEqual([110, 125]);
});

test("a delayed usage flush preserves the next request's observed tool-end boundary", () => {
  const fold = new ContextFold("codex");
  fold.apply(row("turn_context", { turn_id: "one" }, 1000));
  fold.apply(row("response_item", { type: "function_call", name: "exec_command", call_id: "c", arguments: "{}" }, 2000));
  fold.apply(row("response_item", { type: "function_call_output", call_id: "c", output: "done" }, 5000));
  fold.apply(usage("old", { input_tokens: 100, output_tokens: 10 }, 6000));
  fold.apply(respond("assistant", "answer", 6500));
  fold.apply(usage("new", { input_tokens: 110, output_tokens: 15 }, 7000));
  expect(fold.requests).toMatchObject([
    { estimatedModelStart: 1000, estimatedModelEnd: 2000, usageAt: 6000 },
    { estimatedModelStart: 5000, estimatedModelEnd: 7000, usageAt: 7000 },
  ]);
});

test("counts additions, deletions and empty diff lines for each patch file", () => {
  const fold = new ContextFold("codex");
  fold.apply(row("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "patch",
    input: ["*** Begin Patch", "*** Add File: one", "+first", "*** Update File: two", "@@", "-old", "+", "++second", "*** End Patch"].join("\r\n") }, 1000));
  expect(fold.files.map(({ path, added, removed }) => ({ path, added, removed }))).toEqual([
    { path: "one", added: 1, removed: 0 }, { path: "two", added: 2, removed: 1 },
  ]);
});

test("empty legacy token_count neither creates a phantom step nor disables cumulative delta tracking", () => {
  const fold = new ContextFold("codex");
  fold.apply(row("turn_context", { turn_id: "one" }, 1000));
  fold.apply(respond("assistant", "thinking", 1500));
  fold.apply(row("event_msg", { type: "token_count", info: { total_token_usage: {} } }, 2000));
  expect(fold.requests).toHaveLength(0);
  fold.apply(row("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 80, output_tokens: 20 } } }, 3000));
  expect(fold.requests).toHaveLength(1);
  expect(fold.requests[0]).toMatchObject({
    usage: { input: 80, output: 20 },
    estimatedModelStart: 1000,
    estimatedModelEnd: 3000,
  });
});
