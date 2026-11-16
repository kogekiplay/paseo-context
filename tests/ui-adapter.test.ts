import { describe, expect, test } from "vitest";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { ContextFold } from "../server/fold";
import { upstreamOf } from "../server/upstream";
import { aggregate, ContextService } from "../server/service";
import { spansOf, timingOf } from "../server/timing";
import { assemble } from "../shared/core/assemble";
import { scopeSchema, type Agent } from "../shared/contracts";

const agent: Agent = { id: "agent-a", workspaceId: null, parentId: null, title: "Fixture", cwd: "/project",
  provider: "codex", model: "test", sessionId: null, createdAt: 1000, updatedAt: 20000, running: false, archived: false };

const row = (type: string, payload: unknown, time: number) => ({ type, payload, timestamp: new Date(time).toISOString() });
const user = (value: string, time = 1000) => row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: value }] }, time);
const answer = (time: number) => row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer" }] }, time);
const usage = (id: string, time: number) => row("token_usage_record", { response_id: id, turn_id: "one", usage: { input_tokens: 100, output_tokens: 20 } }, time);
const adapt = (fold: ContextFold) => upstreamOf({ fold, requests: fold.requests, summary: fold.summary(agent), agent, revision: fold.revision });

describe("Original UI data contracts", () => {
  test("keeps selected request identities immutable and resets per-turn step labels", () => {
    const fold = new ContextFold("codex");
    fold.apply(row("turn_context", { turn_id: "one" }, 1000));
    fold.apply(user("First")); fold.apply(answer(2000)); fold.apply(usage("a", 3000));
    const selected = adapt(fold).head.requests[0].seq;
    fold.apply(answer(4000)); fold.apply(usage("b", 5000));
    fold.apply(row("turn_context", { turn_id: "two" }, 6000));
    fold.apply(user("Second", 6000)); fold.apply(answer(7000)); fold.apply(usage("c", 8000));
    const data = adapt(fold);
    expect(data.head.requests[0].seq).toBe(selected);
    expect(data.head.requests.map((r) => r.step)).toEqual([1, 2, 1]);
    expect(assemble(data.head, data.headers, selected).nodes.map((n) => n.text)).toContain("First");
    expect(assemble(data.head, data.headers, selected).nodes.map((n) => n.text)).not.toContain("Answer");
  });
  test("preserves complete schema snapshots, including a subsequent empty epoch", () => {
    const fold = new ContextFold("codex");
    fold.apply(row("turn_context", { turn_id: "one", tools: [{ name: "alpha" }, { name: "beta" }] }, 1000));
    fold.apply(user("Use a tool")); fold.apply(answer(2000)); fold.apply(usage("a", 3000));
    let data = adapt(fold);
    expect(assemble(data.head, data.headers, null).header?.tools.map((t) => t.name)).toEqual(["alpha", "beta"]);
    const selected = data.head.requests[0].seq;
    fold.apply(row("turn_context", { turn_id: "two", tools: [] }, 4000));
    data = adapt(fold);
    expect(assemble(data.head, data.headers, null).header?.tools).toEqual([]);
    expect(assemble(data.head, data.headers, selected).header?.tools).toHaveLength(2);
  });
  test("a rollback without a replacement message excludes removed content at the next request", () => {
    const fold = new ContextFold("codex");
    fold.apply(row("turn_context", { turn_id: "one" }, 1000));
    fold.apply(user("Removed")); fold.apply(answer(2000)); fold.apply(usage("a", 3000));
    fold.apply(row("event_msg", { type: "thread_rolled_back", num_turns: 1 }, 4000));
    fold.apply(usage("b", 5000));
    const data = adapt(fold);
    expect(assemble(data.head, data.headers, data.head.requests[1].seq).nodes).toEqual([]);
    expect(assemble(data.head, data.headers, data.head.requests[0].seq).nodes.some((n) => n.text === "Removed")).toBe(true);
  });
  test("parallel tool durations retain summed work and elapsed busy time separately", () => {
    const fold = new ContextFold("codex");
    for (const callId of ["a", "b"]) fold.apply(row("response_item", { type: "function_call", call_id: callId, name: "exec_command", arguments: '{"cmd":"test"}' }, 1000));
    for (const callId of ["a", "b"]) fold.apply(row("response_item", { type: "function_call_output", call_id: callId, output: "Process exited with code 0" }, 11000));
    const timing = timingOf(fold.summary(agent));
    expect(timing.toolsMs).toBe(20000);
    expect(timing.toolBusyMs).toBe(10000);
    expect(timing.wallMs).toBe(10000);
    expect(spansOf(fold.summary(agent).intervals ?? []).reduce((n, span) => n + span.end - span.start, 0)).toBe(10000);
    expect(adapt(fold).head.nodes.filter((node) => node.cat === "tool").every((node) => node.tool === "exec_command")).toBe(true);
  });
  test("overview counts and timing cover the scope before paging", () => {
    const now = new Date(2026, 10, 16, 12).getTime(), yesterday = now - 86400000;
    const fold = new ContextFold("codex");
    for (const [id, time] of [["old", yesterday], ["today", now]] as const) {
      fold.apply(user(id, time));
      fold.apply(row("response_item", { type: "function_call", call_id: id, name: "exec_command", arguments: '{"cmd":"test"}' }, time));
      fold.apply(row("response_item", { type: "function_call_output", call_id: id, output: "Process exited with code 0" }, time + 1000));
      fold.apply(answer(time + 2000)); fold.apply(usage(id, time + 3000));
    }
    const sessions = Array.from({ length: 30 }, (_, index) => fold.summary({ ...agent, id: `agent-${index}`, archived: index < 3 }));
    const requests = new Map(sessions.map((s) => [s.agent.id, fold.requests.map((r) => ({ ...r, costUsd: 0.01 }))]));
    const data = aggregate(sessions, requests, scopeSchema.parse({ range: "today" }), 24, 30, 0, now);
    expect(data.sessions).toHaveLength(6);
    expect(data.toolCalls).toBe(30);
    expect(data.calls).toBe(30);
    expect(data.toolsMs).toBe(30000);
    expect(data.costSessions).toBe(30);
    expect(data.archivedScoped).toBe(3);
    expect(data.groupCounts).toEqual([{ key: "/project", count: 30 }]);
    expect(data.tallySessionCounts.tools.exec_command).toBe(30);
  });
  test("timeline fallback expands stdout and arguments from the correct normalized block", async () => {
    const service = new ContextService();
    const raw = { ...agent, createdAt: new Date(1000).toISOString(), updatedAt: new Date(2000).toISOString(), labels: {}, status: "idle", persistence: null } as unknown as PaseoAgent;
    const paseo = { agents: { ref: () => ({
      refresh: async () => ({ agent: raw }),
      timeline: { refetch: async () => ({ hasOlder: false, entries: [{ timestamp: "2026-11-16T01:00:00Z", item: {
        type: "tool_call", id: "call", name: "bash", status: "completed", input: { command: "echo hello" },
        detail: { type: "shell", command: "echo hello", output: "hello\n", exitCode: 0 },
      } }] }) },
    }) } } as unknown as PaseoApi;
    expect(await service.content(agent.id, 0, paseo)).toContain("echo hello");
    expect(await service.content(agent.id, 1, paseo)).toContain("hello\n");
    expect(await service.content(agent.id, 1, paseo)).not.toContain("echo hello");
    const first = await service.load(raw, paseo), second = await service.load(raw, paseo);
    expect(second.revision).toBe(first.revision);
    const changed = await service.load({ ...raw, lastUsage: { totalCostUsd: 0.5 } } as PaseoAgent, paseo);
    expect(changed.revision).toBeGreaterThan(first.revision);
    service.clear();
  });
});
