import { execFileSync } from "node:child_process";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { ContextFold } from "../server/fold";
import { historyPage } from "../server/history";
import { upstreamOf } from "../server/upstream";
import { eventSchema, type Agent } from "../shared/contracts";
import { milestoneKindOf } from "../shared/core/milestones";

const agent = { id: "workflow-test", provider: "codex", model: "test", title: "Workflow",
  cwd: "/example", workspaceId: null, sessionId: null, parentId: null, createdAt: 1000, updatedAt: 9000,
  running: false, archived: false } satisfies Agent;

function fixture() {
  const fold = new ContextFold("codex");
  const apply = (type: string, payload: unknown) => fold.apply({ type, payload, timestamp: (fold.revision + 1) * 1000 });
  const tool = (name: string, args: object, output: unknown, failed?: boolean) => {
    const call_id = `call-${fold.revision}`;
    apply("response_item", { type: "function_call", name, call_id, arguments: args });
    apply("response_item", { type: "function_call_output", call_id, output,
      ...(failed === undefined ? {} : { is_error: failed }) });
  };
  return { fold, tool, apply };
}

test("records additions and completions from plan updates, with counts and the first eight labels", () => {
  const { fold, tool } = fixture();
  const titles = Array.from({ length: 10 }, (_, i) => `Work item ${i + 1}`);
  const todos = titles.map((content) => ({ content, status: "pending" }));
  tool("TodoWrite", { todos }, "Updated");
  tool("TodoWrite", { todos: todos.slice().reverse() }, "Reordered");
  const completed = todos.map((todo) => ({ ...todo, status: "completed" }));
  tool("TodoWrite", { todos: completed }, "Failed", true);
  tool("TodoWrite", { todos: [...completed, { content: "Extra", status: "in_progress" }] }, "Updated");
  const plan = [{ id: "a", step: "Original label", status: "in_progress" }];
  tool("functions.update_plan", { plan }, "Plan updated");
  tool("functions.update_plan", { plan: [{ id: "a", step: "Renamed label", status: "completed" }] }, "Plan updated");
  expect(fold.events.map(({ kind, count, items, title }) => ({ kind, count, items, title }))).toEqual([
    { kind: "todo-add", count: 10, items: titles.slice(0, 8), title: titles[0] },
    { kind: "todo-add", count: 1, items: ["Extra"], title: "Extra" },
    { kind: "todo-done", count: 10, items: titles.slice(0, 8), title: titles[0] },
    { kind: "todo-add", count: 1, items: ["Original label"], title: "Original label" },
    { kind: "todo-done", count: 1, items: ["Renamed label"], title: "Renamed label" },
  ]);
  expect(fold.events[1].seq).toBe(fold.events[2].seq);
  expect(fold.events[1].ord).toBeLessThan(fold.events[2].ord!);
});

test.each(["TodoWrite", "update_plan"] as const)("preserves unnamed duplicates in %s across snapshot changes", (name) => {
  const { fold, tool } = fixture();
  const snapshot = (...statuses: string[]) => {
    const rows = statuses.map((status) => ({ content: "Review", step: "Review", status }));
    tool(name, name === "TodoWrite" ? { todos: rows } : { plan: rows }, "Updated");
  };
  snapshot("pending", "in_progress");
  snapshot("completed", "in_progress");
  snapshot("in_progress", "completed"); // Reordered, with the same state counts.
  snapshot("in_progress", "completed", "completed"); // The new row may already be completed.
  snapshot("completed", "completed", "completed");
  expect(fold.events.map(({ kind, count, items }) => ({ kind, count, items }))).toEqual([
    { kind: "todo-add", count: 2, items: ["Review", "Review"] },
    { kind: "todo-done", count: 1, items: ["Review"] },
    { kind: "todo-add", count: 1, items: ["Review"] },
    { kind: "todo-done", count: 1, items: ["Review"] },
  ]);
});

test("reserves explicit IDs before assigning positional IDs to unnamed tasks", () => {
  const { fold, tool } = fixture();
  const unnamed = { content: "Review", status: "pending" };
  const named = { ...unnamed, id: "todos-0" };
  tool("TodoWrite", { todos: [unnamed, named] }, "Updated");
  tool("TodoWrite", { todos: [named, { ...unnamed, status: "completed" }] }, "Updated");
  expect(fold.events.map(({ kind, count }) => [kind, count])).toEqual([["todo-add", 2], ["todo-done", 1]]);
  expect(fold.collaboration.tasks.get("todos-0")?.status).toBe("pending");
});

test("unmarked refusal and ambiguous text cannot confirm workflow changes", () => {
  const { fold, tool } = fixture();
  tool("spawn_agent", { message: "Start work" }, "Tool execution failed: maximum agent depth reached");
  tool("spawn_agent", { message: "Start work" }, "Waiting for admission");
  tool("spawn_agent", { message: "Start work" }, { status: "rejected", agent_id: "rejected-child" });
  tool("create_goal", { objective: "New goal" }, "A goal is already active.");
  tool("create_goal", { objective: "New goal" }, "Request received");
  tool("complete_goal", { objective: "New goal" }, "No active goal.");
  tool("TaskCreate", { subject: "Reject me" }, "Permission denied: cannot create tasks");
  tool("TodoWrite", { todos: [{ content: "Reject me", status: "pending" }] }, "Tool execution failed: list is read-only");
  tool("complete_goal", { objective: "New goal" }, { success: true, goal: { status: "active", objective: "Unchanged" } });
  expect(fold.events).toEqual([]);
  expect(fold.collaboration.children.size).toBe(0);
  expect(fold.collaboration.tasks.size).toBe(0);
  const results = [...fold.toolResults.values()];
  expect(results[0]).toMatchObject({ error: true, preview: "Tool execution failed: maximum agent depth reached" });
  expect(results[3]).toMatchObject({ error: true, preview: "A goal is already active." });

  tool("TaskCreate", { subject: "Confirmed task" }, "Task #1 created successfully");
  tool("TaskUpdate", { taskId: "1", status: "completed" }, "Task #1 not found.");
  expect(fold.collaboration.tasks.get("1")?.status).toBe("pending");
  tool("TaskUpdate", { taskId: "1", status: "completed" }, "Updated task #1 status");
  tool("spawn_agent", { message: "Start work" }, { agent_id: "real-child" });
  tool("spawn_agent", { message: "Background run" }, "Async agent launched successfully.\nagentId: other-child");
  tool("create_goal", { objective: "Confirmed goal" }, { goal: { objective: "Confirmed goal", status: "active" } });
  tool("complete_goal", { objective: "Confirmed goal" }, "Goal marked complete.");
  tool("complete_goal", {}, "Goal completed.");
  expect(fold.events.map(({ kind, title, agent }) => [kind, title, agent])).toEqual([
    ["team-task-create", "Confirmed task", undefined],
    ["team-task-complete", "Confirmed task", undefined],
    ["agent", "Start work", "real-child"],
    ["agent", "Background run", "other-child"],
    ["goal-create", "Confirmed goal", undefined],
    ["goal-complete", "Confirmed goal", undefined],
    ["goal-complete", "", undefined],
  ]);
});

test("projects native goal change events even without tool acknowledgements", () => {
  const { fold } = fixture();
  for (const operation of ["create", "complete"]) fold.apply({
    type: "goal/change", timestamp: (fold.revision + 1) * 1000,
    data: { operation, goal: { objective: "Record the state change" } },
  });
  expect(fold.events.map(({ kind, title }) => [kind, title])).toEqual([
    ["goal-create", "Record the state change"], ["goal-complete", "Record the state change"],
  ]);
});

test("projects questions, confirmed delegations, team transitions and captured goal changes", () => {
  const { fold, apply, tool } = fixture();
  apply("turn_context", { turn_id: "first" });
  tool("AskUserQuestion", { questions: [{ question: "  Which test?  " }, { question: "When?" }, {}] }, "Answer");
  tool("spawn_agent", { message: "Rejected dispatch" }, { error: "Tool unavailable" });
  tool("functions.spawn_agent", { message: "Run the test" }, { agent_id: "child-001" });
  tool("TaskCreate", { subject: "Check pagination" }, "Task #3 created successfully");
  tool("TaskUpdate", { taskId: "3", status: "completed" }, "", true);
  tool("TaskUpdate", { taskId: "3", status: "completed" }, { success: true });
  tool("TaskUpdate", { taskId: "3", status: "completed" }, { success: true });
  tool("create_goal", { objective: "Verify pagination" }, { goal: { objective: "Verify pagination" } });
  tool("update_goal", {}, { goal: { objective: "Verify pagination", status: "complete" } });
  tool("my_ordinary_tool", { subject: "not a task", status: "completed" }, { success: true });
  apply("token_usage_record", { response_id: "one", turn_id: "first", usage: { input_tokens: 100, output_tokens: 10 } });
  // Replacement history is context replay, including tool actions it contains.
  apply("compacted", { replacement_history: [
    { type: "function_call", name: "ask_question", call_id: "replayed", arguments: { question: "Replayed question" } },
  ] });
  const head = upstreamOf({ fold, agent, summary: fold.summary(agent), requests: fold.requests, revision: 9 }).head;
  expect(fold.events.map((row) => eventSchema.parse(row))).toEqual(fold.events);
  expect(head.events.map((row) => row.kind)).toEqual([
    "ask", "agent", "team-task-create", "team-task-complete", "goal-create", "goal-complete", "compaction",
  ]);
  expect(head.events[0]).toMatchObject({ ord: 0, name: "Which test?", count: 2, items: ["Which test?", "When?"], turn: 1, step: 1 });
  expect(head.events[1]).toMatchObject({ ord: 1, name: "Run the test", agent: "child-001" });
  expect(head.events[3]).toMatchObject({ name: "Check pagination", count: 1 });
  expect(head.events[5]).toMatchObject({ name: "Verify pagination", count: 1 });
  expect(milestoneKindOf(head.events[1])).toBe("spawn");
  expect(historyPage(head, "milestones", {}).rows).toEqual(head.events);
});

test("uses Paseo sub-agent tool facts in a timeline without native records", () => {
  const fold = new ContextFold("timeline");
  fold.apply({ type: "tool_call", name: "Agent", status: "running", callId: "running", timestamp: 1000,
    detail: { type: "sub_agent", childSessionId: "child-1", description: "Investigate" } });
  fold.apply({ type: "tool_call", name: "Agent", status: "completed", callId: "completed", timestamp: 2000,
    detail: { type: "sub_agent", childSessionId: "child-2", description: "Summarize" } });
  fold.apply({ type: "tool_call", name: "Agent", status: "failed", callId: "failed", timestamp: 3000,
    detail: { type: "sub_agent", description: "Unavailable" } });
  fold.apply({ type: "tool_call", name: "Agent", status: "running", callId: "unconfirmed", timestamp: 4000,
    detail: { type: "sub_agent", description: "Starting" } });
  fold.apply({ type: "tool_call", name: "Agent", status: "completed", callId: "refused", timestamp: 5000,
    detail: { type: "sub_agent", description: "Unavailable", output: "Tool execution failed: maximum agent depth reached" } });
  fold.apply({ type: "tool_call", name: "Agent", status: "completed", callId: "confirmed", timestamp: 6000,
    detail: { type: "sub_agent", description: "Completed without an exported child ID" } });
  expect(fold.events.map(({ kind, title, agent }) => ({ kind, title, agent }))).toEqual([
    { kind: "agent", title: "Investigate", agent: "child-1" },
    { kind: "agent", title: "Summarize", agent: "child-2" },
    { kind: "agent", title: "Completed without an exported child ID", agent: undefined },
  ]);
});

test("retaining workflow labels releases the large source strings after the fold is collected", () => {
  execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { ContextFold } from "./server/fold.ts";
    const mib = 1024 * 1024;
    function capture() {
      const fold = new ContextFold("codex");
      const todos = Array.from({ length: 9 }, (_, i) => ({ content: Buffer.alloc(mib, 65 + i).toString(), status: "pending" }));
      fold.apply({ type: "response_item", payload: { type: "function_call", name: "TodoWrite", call_id: "todo", arguments: { todos } } });
      fold.apply({ type: "response_item", payload: { type: "function_call_output", call_id: "todo", output: "Updated" } });
      fold.apply({ type: "response_item", payload: { type: "function_call", name: "ask_question",
        arguments: { question: Buffer.alloc(8 * mib, 90).toString() } } });
      return fold.events;
    }
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const events = capture();
    global.gc(); global.gc();
    const growth = process.memoryUsage().heapUsed - before;
    assert.equal(events[0].count, 9);
    assert.equal(events[0].items.length, 8);
    assert.equal(events[0].items[0], "A".repeat(180));
    assert.equal(events[1].items[0], "Z".repeat(180));
    assert.ok(growth < 4 * mib, "Workflow labels retained " + growth + " bytes");
  `], { cwd: new URL("..", import.meta.url), timeout: 10_000 });
});
