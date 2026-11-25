import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { expect, test, vi } from "vitest";
import { antigravityTaskResult, commandExitCode } from "../server/antigravity-log";
import { agentReportsOf } from "../server/collaboration";
import { ContextFold } from "../server/fold";
import { Pricing } from "../server/pricing";
import { ContextService } from "../server/service";
import { prefixedWorkflowResult } from "../server/workflow-result";

const time = new Date("2026-11-24T12:00:00Z");
const at = (seconds: number) => new Date(time.getTime() + 1000 * seconds).toISOString();
const foldOf = (provider: string) => new ContextFold(provider);
const PARENT = "paseo.parent-agent-id";

function agent(id: string, provider: string, data: Partial<PaseoAgent> = {}) {
  return { id, provider, title: id, cwd: `/${id}`, workspaceId: null, createdAt: at(0), updatedAt: at(1),
    labels: {}, persistence: null, status: "idle", ...data } as PaseoAgent;
}

function delegate(fold: ContextFold, id: string) {
  fold.apply({ type: "PLANNER_RESPONSE", step_index: 1, created_at: at(0),
    tool_calls: [{ name: "mcp_paseo_create_agent", args: { title: id } }] });
  fold.apply({ type: "GENERIC", step_index: 2, created_at: at(1), content: JSON.stringify({ agentId: id }) });
}

function fleetFixture(listed: PaseoAgent[], folds: Map<string, ContextFold>) {
  class OfflinePricing extends Pricing { override async refresh() {} }
  const read = vi.fn(async ({ id, provider }: { id: string; provider: string }) => ({
    entry: { fold: folds.get(id) ?? foldOf(provider) },
  }));
  const list = vi.fn(async () => ({ entries: listed.map((agent) => ({ agent })), pageInfo: { hasMore: false } }));
  const paseo = { agents: { list } } as unknown as PaseoApi;
  const service = new ContextService({ read, locate: async () => null, content: async () => "", clear() {} }, new OfflinePricing());
  return { service, paseo, read, list };
}

test("Paseo child labels take precedence over a competing delegation in both directions", async () => {
  const owner = agent("owner", "codex"), claimed = agent("child", "codex", { labels: { [PARENT]: owner.id } });
  const competitor = agent("competitor", "antigravity");
  const fold = foldOf("antigravity");
  delegate(fold, claimed.id);
  const { service, paseo, list } = fleetFixture([owner, claimed, competitor], new Map([[competitor.id, fold]]));
  try {
    await service.load(competitor, paseo); // Loading Context first cannot create a competing discovered edge.
    expect(service["discoveredChildren"].get(competitor.id)?.ids.has(claimed.id)).toBe(false);
    list.mockClear();
    const competing = await service.fleet(competitor.id, paseo, { details: true });
    expect(list).toHaveBeenCalledTimes(1);
    expect(competing.agents.map((item) => item.id)).toEqual([competitor.id]);
    expect(service["discoveredChildren"].get(competitor.id)?.ids.has(claimed.id)).toBe(false);
    const actual = await service.fleet(claimed.id, paseo);
    expect(actual.rootId).toBe(owner.id);
    expect(actual.agents.map(({ id, parentId }) => [id, parentId])).toEqual([[owner.id, null], [claimed.id, owner.id]]);
  } finally { service.clear(); }
});

test("cold Fleet searches different directories in the unassigned workspace pool by update time, at most eight candidates", async () => {
  const child = agent("child", "codex", { createdAt: at(100) });
  const parent = agent("parent", "antigravity", { createdAt: at(-10), updatedAt: at(95) });
  const outsider = agent("other-workspace", "antigravity", { workspaceId: "elsewhere", updatedAt: at(110) });
  const future = agent("future", "antigravity", { createdAt: at(101), updatedAt: at(110) });
  const decoys = Array.from({ length: 8 }, (_, i) => agent(`decoy-${i}`, "antigravity", { updatedAt: at(i + 10) }));
  const fold = foldOf(parent.provider);
  delegate(fold, child.id);
  const listed = [child, parent, outsider, future, ...decoys];
  const folds = new Map([[parent.id, fold]]);
  const hot = fleetFixture(listed, folds);
  try {
    const result = await hot.service.fleet(child.id, hot.paseo);
    expect(child.cwd).not.toBe(parent.cwd);
    expect(result.rootId).toBe(parent.id);
    expect(hot.read.mock.calls[0]?.[0].id).toBe(parent.id);
    expect(hot.read.mock.calls.map(([item]) => item.id)).not.toContain(outsider.id);
    expect(hot.read.mock.calls.map(([item]) => item.id)).not.toContain(future.id);
  } finally { hot.service.clear(); }
  parent.updatedAt = at(1);
  const limited = fleetFixture(listed, folds);
  try {
    expect((await limited.service.fleet(child.id, limited.paseo)).rootId).toBe(child.id);
    expect(limited.read.mock.calls.map(([item]) => item.id)).toEqual([...decoys.map(({ id }) => id).reverse(), child.id]);
  } finally { limited.service.clear(); }
});

test("Codex commands retain exit codes in the middle of long output without leaving the body in RegExp.input", () => {
  const fold = foldOf("codex");
  const chunk = "output\n".repeat(310_000);
  const output = `${chunk}Process exited with code 23\n${chunk}`;
  const code = commandExitCode(output), retained = RegExp.input;
  expect(code).toBe("23");
  expect(retained).toBe("");
  fold.apply({ type: "response_item", timestamp: at(0), payload: {
    type: "function_call", name: "exec_command", arguments: { cmd: "false" }, call_id: "exec",
  } });
  fold.apply({ type: "response_item", timestamp: at(1), payload: {
    type: "function_call_output", call_id: "exec", output,
  } });
  expect(fold.commands[0]).toMatchObject({ status: "failed", exit: 23 });
});

test("managed task acknowledgements reject mismatched IDs and keep explicit failures when exit is zero", () => {
  const id = "session/task-22";
  expect(antigravityTaskResult('Status: DONE\nTask ID: "other:task-22"\nExit Code: 9', "status", id)).toBeNull();
  expect(antigravityTaskResult('Task "other:task-22" aborted.\nCommand exited with code 0', "kill", id)).toBeNull();
  for (const state of ["TIMED_OUT", "TIMED OUT", "TIMEOUT", "CANCELED", "CANCELLED", "KILLED", "FAILED", "ERROR", "TERMINATED", "ABORTED"]) {
    expect(antigravityTaskResult(`Task ID: "${id}"\nStatus: ${state}\nExit Code: 0`, "status", id)).toEqual({ status: "failed", exit: 0 });
  }
  const fold = foldOf("antigravity");
  const step = (index: number, name: string, args: Record<string, string>, content: string) => {
    fold.apply({ type: "PLANNER_RESPONSE", step_index: index, created_at: at(index), tool_calls: [{ name, args }] });
    fold.apply({ type: "GENERIC", step_index: index + 1, created_at: at(index + 1), status: "DONE", content });
  };
  step(1, "run_command", { CommandLine: "wait" }, `Tool is running as a background task with task id: ${id}`);
  step(3, "manage_task", { Action: "status", TaskId: id }, "Task ID: different\nStatus: done\nExit Code: 9");
  expect(fold.commands[0]).toMatchObject({ status: "running", exit: null });
  step(5, "manage_task", { Action: "kill", TaskId: id }, `Task ID: ${id}\nStatus: CANCELED\nExit Code: 0`);
  expect(fold.commands[0]).toMatchObject({ status: "failed", exit: 0 });
});

test("extracts 70 KiB reports with or without a leading acknowledgement", () => {
  const body = "x".repeat(70 * 1024);
  const result = JSON.stringify({ status: "completed", agentId: "child", result: body });
  for (const prefix of ["", "Result:\n"]) {
    expect(agentReportsOf(prefix + result, true)).toEqual([{ from: "child", status: "completed", text: body }]);
  }
  expect(prefixedWorkflowResult("x".repeat(2048) + "\n" + result)).toEqual({});
  expect(prefixedWorkflowResult(`Result:\n${JSON.stringify({ result: "x".repeat(512 * 1024) })}`)).toEqual({});
});
