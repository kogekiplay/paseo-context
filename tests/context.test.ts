import { describe, expect, test } from "vitest";
import { ContextFold } from "../server/fold";
import { messagesOf, toolKind } from "../server/normalize";
import { emptyParts, emptyUsage, scopeSchema, type Agent, type Request } from "../shared/contracts";
import { aggregate } from "../server/service";

export const agent: Agent = {
  id: "agent-a", workspaceId: "workspace", parentId: null, title: "Fixture session", cwd: "/project",
  provider: "codex", model: "test-model", sessionId: "fixture", createdAt: 1000, updatedAt: 20000,
  running: false, archived: false,
};
const row = (type: string, payload: unknown, at = 1000) => ({ type, payload, timestamp: new Date(at).toISOString() });
const item = (payload: unknown, at?: number) => row("response_item", payload, at);
const usage = (id: string, input = 1000, output = 100, at = 5000) => row("token_usage_record", {
  response_id: id, turn_id: "turn-one", usage: { input_tokens: input, cached_input_tokens: input / 2, output_tokens: output },
}, at);
const user = (content = "Help me test context") => item({ type: "message", role: "user", content: [{ type: "input_text", text: content }] });
const answer = (content = "Done") => item({ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }, 4000);

describe("Native context reconstruction", () => {
  test("keeps provider usage separate from estimated composition and deduplicates response usage", () => {
    const fold = new ContextFold("codex");
    fold.apply(row("session_meta", { base_instructions: { text: "System prompt" } }));
    fold.apply(row("turn_context", { model: "test-model" }));
    fold.apply(user()); fold.apply(answer()); fold.apply(usage("response-one")); fold.apply(usage("response-one"));
    const s = fold.summary(agent);
    expect(s.usage.input).toBe(1000);
    expect(s.usage.output).toBe(100);
    expect(s.steps).toBe(1);
    expect(fold.requests).toHaveLength(1);
    expect(fold.requests[0].parts.assistant).toBe(0);
    expect(fold.requests[0].parts.user).toBeGreaterThan(0);
    expect(s.parts.assistant).toBeGreaterThan(0);
    expect(s.notices).toContain("native-estimate");
  });
  test("preserves archived content with an explicit compaction boundary", () => {
    const fold = new ContextFold("codex");
    fold.apply(user("old prompt")); fold.apply(answer()); fold.apply(usage("a"));
    const first = fold.requests[0];
    fold.apply(row("compacted", { message: "Compaction summary" }, 6000));
    fold.apply(answer("New answer")); fold.apply(usage("b", 300, 30, 8000));
    const old = fold.nodes[0];
    expect(old.gone).toBeDefined();
    expect(old.gone!).toBeGreaterThanOrEqual(first.boundary);
    expect(old.gone!).toBeLessThan(fold.requests[1].boundary);
    expect(fold.summary(agent).parts.user).toBe(0);
    expect(fold.events.some((e) => e.kind === "compaction")).toBe(true);
    expect(fold.summary(agent).usage.input).toBe(1300);
  });
  test("pairs shell commands, failures, and tool results", () => {
    const fold = new ContextFold("codex");
    fold.apply(item({ type: "function_call", name: "functions.exec_command", call_id: "call-a",
      arguments: JSON.stringify({ cmd: "cd /project && npm test", workdir: "/project" }) }, 1000));
    fold.apply(item({ type: "function_call_output", call_id: "call-a", output: "Process exited with code 1\nfailed" }, 3000));
    expect(fold.commands[0]).toMatchObject({ status: "failed", exit: 1, duration: 2000, outputNode: 1 });
    expect(fold.commands[0].programs).toContain("npm");
    expect(fold.nodes[1].tool).toBe("functions.exec_command");
    expect(fold.summary(agent).toolMs).toBe(2000);
  });
  test("maps Claude reads, tool results, partial usage and cache creation", () => {
    const fold = new ContextFold("claude");
    fold.apply({ type: "user", uuid: "u1", message: { content: "Read file" }, timestamp: new Date(1000).toISOString() });
    const message = { id: "m1", model: "claude-test", content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/project/a.ts" } }],
      usage: { input_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 30, output_tokens: 5 } };
    fold.apply({ type: "assistant", message, timestamp: new Date(2000).toISOString() });
    fold.apply({ type: "assistant", message: { ...message, usage: { ...message.usage, output_tokens: 10 } }, timestamp: new Date(2500).toISOString() });
    fold.apply({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "File content", is_error: true }] }, timestamp: new Date(3000).toISOString() });
    expect(fold.summary(agent).usage).toMatchObject({ input: 150, cacheRead: 100, cacheWrite: 30, output: 10 });
    expect(fold.requests).toHaveLength(1);
    expect(fold.files[0]).toMatchObject({ path: "/project/a.ts", kind: "read", error: true });
    expect(fold.summary(agent).toolCalls).toBe(1);
  });
  test("does not treat user files as a path to execute", () => {
    expect(toolKind("functions.exec_command")).toBe("bash");
    expect(toolKind("Read")).toBe("read");
    expect(messagesOf({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Add File: test", call_id: "p" } }, "codex")[0].args).toEqual({ input: "*** Add File: test" });
  });
});

describe("Overview accounting", () => {
  const request = (at: number, turn: number, usd: number | null = 0.01): Request => ({
    id: `${at}`, index: turn, turn, time: at, boundary: 1, parts: { ...emptyParts(), user: 1 }, usage: { ...emptyUsage(), input: 100, output: 20 },
    model: "test", duration: null, prompt: "", response: "", costUsd: usd,
  });
  test("attributes usage to request dates instead of a session last-updated date", () => {
    const now = new Date(2026, 10, 16, 12).getTime(), yesterday = now - 86400000;
    const s = new ContextFold("codex").summary({ ...agent, updatedAt: now });
    const result = aggregate([s], new Map([[agent.id, [request(yesterday, 1), request(now, 2)]]]), scopeSchema.parse({ range: "today" }), 0, 1, 0, now);
    expect(result.tokens).toBe(120);
    expect(result.turns).toBe(1);
    expect(result.days).toHaveLength(2);
    expect(result.costComplete).toBe(true);
    expect(result.parts.user).toBe(100);
  });
  test("unknown model costs remain unknown and do not become zero", () => {
    const now = Date.now(), s = new ContextFold("codex").summary(agent);
    const result = aggregate([s], new Map([[agent.id, [request(now, 1, null)]]]), scopeSchema.parse({ range: "all" }), 0, 1, 0, now);
    expect(result.costUsd).toBeNull();
    expect(result.costComplete).toBe(false);
  });
  test("counts the entire filtered scope independently of the displayed page", () => {
    const all = Array.from({ length: 30 }, (_, i) => new ContextFold("codex").summary({ ...agent, id: `agent-${i}`, updatedAt: i }));
    const requests = new Map(all.map((s) => [s.agent.id, [request(Date.now(), 1)]]));
    const first = aggregate(all, requests, scopeSchema.parse({ range: "all" }), 0, 30, 0);
    const second = aggregate(all, requests, scopeSchema.parse({ range: "all" }), 24, 30, 0);
    expect(first.total).toBe(30); expect(first.sessions).toHaveLength(24);
    expect(second.sessions).toHaveLength(6); expect(first.tokens).toBe(3600); expect(second.tokens).toBe(3600);
  });
});
