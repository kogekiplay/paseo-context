import type { PaseoApi } from "@getpaseo/client";
import { expect, test, vi } from "vitest";
import { PaseoSubtasks } from "../server/subtasks";
import { teamOfFleet } from "../server/ui-fleet";
import type { Agent } from "../shared/contracts";

const entry = (callId: string, status: string, childSessionId = "child-native") => ({
  item: { type: "tool_call", callId, name: "Subtask", status,
    detail: { type: "sub_agent", childSessionId, description: `Assignment ${callId}` } },
});
function harness(pages: unknown[]) {
  const refetch = vi.fn();
  for (const page of pages) refetch.mockResolvedValueOnce(page);
  return { refetch, paseo: { agents: { ref: () => ({ timeline: { refetch } }) } } as unknown as PaseoApi };
}
test("Paseo subtask history retains every page and resolves repeated call IDs to their latest state", async () => {
  const h = harness([
    { epoch: "a", entries: [entry("one", "completed"), entry("two", "running")], hasOlder: true, startCursor: { seq: 200 } },
    { epoch: "a", entries: [entry("one", "running"), entry("three", "failed")], hasOlder: false },
  ]);
  const source = new PaseoSubtasks();
  const first = source.read("root", 1, h.paseo), duplicate = source.read("root", 1, h.paseo);
  expect(first).toBe(duplicate);
  const tasks = await first;
  expect(tasks).toHaveLength(3);
  expect(tasks.find((task) => task.callId === "one")?.status).toBe("completed");
  expect(tasks.find((task) => task.callId === "two")?.status).toBe("in_progress");
  expect(tasks.find((task) => task.callId === "three")?.status).toBe("failed");
  await source.read("root", 1, h.paseo);
  expect(h.refetch).toHaveBeenCalledTimes(2);
  source.clear();
  await expect(source.read("root", 1, h.paseo)).rejects.toThrow("stopped");
});
test("history gaps and epoch replacements never masquerade as a complete task list", async () => {
  for (const pages of [
    [{ epoch: "a", entries: [], hasOlder: true }],
    [{ epoch: "a", entries: [], hasOlder: true, startCursor: { seq: 2 } }, { epoch: "b", entries: [], hasOlder: false }],
    [{ epoch: "a", entries: [], hasOlder: true, startCursor: { seq: 2 } }, { epoch: "a", entries: [], hasOlder: true, startCursor: { seq: 2 } }],
  ]) {
    const h = harness(pages), source = new PaseoSubtasks();
    await expect(source.read("root", 1, h.paseo)).rejects.toThrow();
    source.clear();
  }
});

test("shares requests for the same revision and prevents an older completion from replacing a newer one", async () => {
  let finishOld!: (page: unknown) => void;
  const oldPage = new Promise((resolve) => { finishOld = resolve; });
  const refetch = vi.fn()
    .mockReturnValueOnce(oldPage)
    .mockResolvedValueOnce({ epoch: "a", entries: [entry("one", "completed")], hasOlder: false });
  const paseo = { agents: { ref: () => ({ timeline: { refetch } }) } } as unknown as PaseoApi;
  const source = new PaseoSubtasks();
  try {
    const oldRead = source.read("root", 1, paseo);
    expect(source.read("root", 1, paseo)).toBe(oldRead);
    const newer = source.read("root", 2, paseo);
    expect(newer).not.toBe(oldRead);
    await expect(newer).resolves.toMatchObject([{ status: "completed" }]);
    finishOld({ epoch: "a", entries: [entry("one", "running")], hasOlder: false });
    await expect(oldRead).resolves.toMatchObject([{ status: "in_progress" }]);
    await expect(source.read("root", 2, paseo)).resolves.toMatchObject([{ status: "completed" }]);
    expect(refetch).toHaveBeenCalledTimes(2);
  } finally { source.clear(); }
});
test("Paseo subtasks resolve existing native children without adding another agent or losing failed/canceled tasks", () => {
  const agents = [
    { id: "root", sessionId: "root-native", provider: "codex", title: "Root" },
    { id: "native:codex:child-native", sessionId: "child-native", provider: "codex", title: "Child" },
  ] as Agent[];
  const team = teamOfFleet({ rootId: "root", agents, loaded: new Map(), failed: 0, total: 2,
    subtasks: new Map([["root", [
      { callId: "a", childId: "child-native", subject: "Review", description: "Review task", status: "completed" },
      { callId: "b", childId: "child-native", subject: "Failed", description: "", status: "failed" },
      { callId: "c", childId: "missing", subject: "Canceled", description: "", status: "canceled" },
    ]]]) });
  expect(team.tasks.map((task) => task.status)).toEqual(["completed", "failed", "canceled"]);
  expect(team.tasks[0].ownerId).toBe("native:codex:child-native");
  expect(team.tasks[2].ownerId).toBeUndefined();
  expect(team.tasks[2].ownerName).toBe("missing");
  expect(agents).toHaveLength(2);
});
