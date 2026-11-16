import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { describe, expect, test, vi } from "vitest";
import type { Agent } from "../shared/contracts";
import { ContextFold } from "../server/fold";
import { messagesOf } from "../server/normalize";
import { UiFleet, teamOfFleet } from "../server/ui-fleet";
import { UiRoutes } from "../server/ui-routes";
import { nodeSeq } from "../server/upstream";
import type { ContextService } from "../server/service";

function session(id: string, sessionId: string, parentId: string | null = null) {
  const agent: Agent = { id, sessionId, parentId, workspaceId: "workspace", title: id, cwd: "/project",
    provider: "codex", model: "test-model", createdAt: 1000, updatedAt: 50000, running: false, archived: false };
  const fold = new ContextFold("codex"), contents = new Map<number, string>();
  let clock = 2000, serial = 0;
  const emit = (payload: Record<string, unknown>, at = clock++) => {
    const before = fold.nodes.length, row = { type: "response_item", payload, timestamp: new Date(at).toISOString() };
    const messages = messagesOf(row, "codex");
    fold.apply(row);
    fold.nodes.slice(before).forEach((node, index) => contents.set(node.id, messages[index].text));
    return before;
  };
  return { agent, fold, contents, emit,
    data: () => ({ agent, fold, summary: fold.summary(agent), requests: fold.requests, revision: clock }),
    message: (role: "user" | "assistant", value: string, at?: number) =>
      emit({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text: value }] }, at),
    call: (name: string, args: unknown) => {
      const callId = `${id}-${serial++}`;
      const nodeId = emit({ type: "function_call", name, arguments: JSON.stringify(args), call_id: callId });
      return { callId, nodeId };
    },
    result: (callId: string, value: unknown) =>
      emit({ type: "function_call_output", call_id: callId, output: typeof value === "string" ? value : JSON.stringify(value) }),
  };
}
type Session = ReturnType<typeof session>;
function harness(fixtures: Session[], unread: string[] = []) {
  const byId = new Map(fixtures.map((s) => [s.agent.id, s]));
  const raw = (s: Session) => ({ ...s.agent, labels: s.agent.parentId ? { "paseo.parent-agent-id": s.agent.parentId } : {},
    status: "idle", persistence: { provider: "codex", sessionId: s.agent.sessionId },
    createdAt: new Date(s.agent.createdAt).toISOString(), updatedAt: new Date(s.agent.updatedAt).toISOString() }) as unknown as PaseoAgent;
  const service = {
    pricing: { refresh: vi.fn(async () => {}) },
    agent: vi.fn(async (id: string) => {
      const fixture = byId.get(id);
      if (!fixture) throw new Error("Missing session");
      return raw(fixture);
    }),
    load: vi.fn(async (agent: PaseoAgent) => {
      if (unread.includes(agent.id)) throw new Error("Unread session");
      const fixture = byId.get(agent.id);
      if (!fixture) throw new Error("Missing session");
      return fixture.data();
    }),
    fleet: vi.fn(async () => ({ rootId: fixtures[0].agent.id,
      members: fixtures.map((s) => s.fold.summary(s.agent)), failed: 0 })),
    content: vi.fn(async (id: string, nodeId: number) => {
      const content = byId.get(id)?.contents.get(nodeId);
      if (content === undefined) throw new Error("Missing source content");
      return content;
    }),
  };
  const paseo = { agents: { list: vi.fn(async () => ({
    entries: fixtures.map((s) => ({ agent: raw(s) })), pageInfo: { hasMore: false },
  })) } } as unknown as PaseoApi;
  return { service: service as unknown as ContextService, paseo, content: service.content, fleet: new UiFleet(service as unknown as ContextService) };
}

describe("Fleet communication contract", () => {
  test("routes outgoing messages to canonical recipients and reports only explicit child completion", async () => {
    const root = session("paseo-root", "root-native");
    const child = session("native:codex:child-native", "child-native", root.agent.id);
    const spawn = root.call("functions.spawn_agent", { message: "Investigate" });
    root.result(spawn.callId, { agent_id: child.agent.sessionId });
    const send = root.call("functions.send_input", { id: child.agent.sessionId, message: "Continue" });
    root.result(send.callId, { submission_id: "ack" });
    const plan = root.call("functions.update_plan", { plan: [{ step: "Investigate", status: "in_progress" }] });
    root.result(plan.callId, "Plan updated");
    const reply = child.call("SendMessage", { recipient: root.agent.id, content: "Working on it" });
    child.result(reply.callId, { success: true });
    const wait = root.call("functions.wait", { ids: [child.agent.sessionId] });
    root.result(wait.callId, { status: { "child-native": { completed: "Investigation done" } }, timed_out: false });
    const { fleet, paseo } = harness([root, child]), family = await fleet.read(root.agent.id, paseo);
    const rootDetail = await fleet.detail(family, root.agent.id, "preview", paseo);
    const childDetail = await fleet.detail(family, child.agent.id, "preview", paseo);
    expect(rootDetail?.messages.map((m) => [m.kind, m.from, m.text])).toEqual([
      ["relay", child.agent.id, "Working on it"], ["settled", child.agent.id, "Investigation done"],
    ]);
    expect(childDetail?.messages.map((m) => [m.from, m.text])).toEqual([[root.agent.id, "Continue"]]);
    expect(rootDetail?.delegations?.[0].to).toBe(child.agent.id);
    expect(rootDetail?.delegations?.[0].seq).toBe(nodeSeq(root.fold, spawn.nodeId));
    const summary = await fleet.summary(family, paseo);
    expect(summary.counts[root.agent.id]).toMatchObject({ messagesTotal: 2, delegationsCount: 1 });
    expect(summary.counts[child.agent.id]).toMatchObject({ messagesTotal: 1, delegationsCount: 0 });
    expect(summary.members.map((m) => m.id)).toEqual([child.agent.id]);
    expect(summary.familySize).toBe(2);
  });

  test("ignores nonterminal wait results and failed message submissions", async () => {
    const root = session("root", "root-native"), child = session("child", "child-native", "root");
    const wait = root.call("wait_agent", { ids: ["child-native"] });
    root.result(wait.callId, { status: { "child-native": "running" }, timed_out: true });
    const send = root.call("send_input", { id: "child-native", message: "Never delivered" });
    root.fold.collaboration.apply({ category: "tool", title: "Failure", text: "Rejected", block: -1,
      callId: send.callId, error: true }, root.fold.nodes.length, 9000);
    const { fleet, paseo } = harness([root, child]), family = await fleet.read("root", paseo);
    expect((await fleet.detail(family, "root", "preview", paseo))?.messages).toEqual([]);
    expect((await fleet.detail(family, "child", "preview", paseo))?.messages).toEqual([]);
  });

  test("retrieves exact full text and reply timestamps while preserving message addresses", async () => {
    const root = session("root", "root-native"), child = session("child", "child-native", "root");
    const prompt = "First line\n" + "delegated prompt ".repeat(150);
    const answer = "Answer\n" + "complete output ".repeat(150);
    const message = "Preserve\n\n" + "message body ".repeat(150);
    child.message("user", prompt, 3000); child.message("assistant", answer, 7000);
    const sent = root.call("send_input", { id: "child-native", message });
    root.result(sent.callId, { submission_id: "ack" });
    const { fleet, paseo, content } = harness([root, child]), family = await fleet.read("root", paseo);
    const preview = await fleet.detail(family, "child", "preview", paseo);
    expect(preview?.messages[0].clipped).toBe(true);
    const full = await fleet.detail(family, "child", "full", paseo);
    expect(full?.initialPrompt).toBe(prompt);
    expect(full?.lastReply).toEqual({ time: 7000, text: answer });
    expect(full?.messages[0].text).toBe(message);
    expect(full?.messages[0].seq).toBe(preview?.messages[0].seq);
    expect(full?.messages[0].clipped).toBeUndefined();
    expect(content).toHaveBeenCalledWith("root", sent.nodeId, paseo);
  });

  test("serves all history and reports unread batch members without fabricating counts", async () => {
    const root = session("root", "root-native"), child = session("child", "child-native", "root");
    for (let i = 0; i < 85; i++) root.call("send_input", { id: "child-native", message: `message ${i}` });
    const { fleet, paseo } = harness([root, child]), family = await fleet.read("root", paseo);
    const preview = await fleet.detail(family, "child", "preview", paseo);
    expect(preview?.messages).toHaveLength(80);
    expect(preview?.messagesTotal).toBe(85);
    expect(preview?.truncated).toBe(true);
    const history = await fleet.handle({ batch: { rootId: "root", ids: ["child"], mode: "history" } }, paseo);
    expect((history.value as { rows: Record<string, { messages: unknown[]; truncated: boolean }> }).rows.child.messages).toHaveLength(85);
    expect((history.value as { rows: Record<string, { truncated: boolean }> }).rows.child.truncated).toBe(false);
    const broken = harness([root, child], ["child"]), partial = await broken.fleet.read("root", broken.paseo);
    expect((await broken.fleet.summary(partial, broken.paseo)).counts).toEqual({});
    const batch = await broken.fleet.handle({ batch: { rootId: "root", ids: ["root", "child"], mode: "preview" } }, broken.paseo);
    expect((batch.value as { missing: string[] }).missing).toEqual(["child"]);
    expect((await broken.fleet.summary(partial, broken.paseo)).familySize).toBe(2);
  });
});

describe("Captured task projections", () => {
  test("reduces successful task updates and preserves subjects, ownership and dependencies", async () => {
    const root = session("root", "root-native"), child = session("child", "child-native", "root");
    const first = root.call("TaskCreate", { subject: "Inspect input", description: "Read the source" });
    root.result(first.callId, { task: { id: "1" } });
    const second = root.call("TaskCreate", { subject: "Implement", description: "Complete implementation" });
    root.result(second.callId, "Task #2 created successfully: Implement");
    const update = root.call("TaskUpdate", { taskId: "2", owner: "child-native", addBlockedBy: ["1"], status: "pending" });
    root.result(update.callId, { success: true });
    const done = root.call("TaskUpdate", { taskId: "1", status: "completed" });
    root.result(done.callId, { success: true });
    const { fleet, paseo } = harness([root, child]), family = await fleet.read("root", paseo), team = teamOfFleet(family);
    expect(team.tasks).toEqual([
      { id: "root:task:1", subject: "Inspect input", description: "Read the source", status: "completed",
        blockedBy: [], writeScopes: [], ready: false, warnings: [] },
      { id: "root:task:2", subject: "Implement", description: "Complete implementation", status: "pending",
        ownerId: "child", blockedBy: ["root:task:1"], writeScopes: [], ready: true, warnings: [] },
    ]);
  });

  test("replaces plan snapshots, keeps session task IDs distinct and rejects failed updates", async () => {
    const root = session("root", "root-native"), child = session("child", "child-native", "root");
    const old = root.call("update_plan", { plan: [{ step: "Old one", status: "pending" }, { step: "Old two", status: "pending" }] });
    root.result(old.callId, "Plan updated");
    const current = root.call("update_plan", { plan: [{ step: "Current", status: "completed" }] });
    root.result(current.callId, "Plan updated");
    const childPlan = child.call("TodoWrite", { todos: [{ content: "Child work", status: "in_progress" }] });
    child.result(childPlan.callId, "Updated");
    const failed = child.call("TaskUpdate", { taskId: "todos-0", status: "completed" });
    child.fold.collaboration.apply({ category: "tool", title: "Failed", text: "No permission", block: -1,
      callId: failed.callId, error: true }, child.fold.nodes.length, 8000);
    const { fleet, paseo } = harness([root, child]), family = await fleet.read("root", paseo), team = teamOfFleet(family);
    expect(team.tasks.map((task) => [task.id, task.subject, task.status, task.ownerId])).toEqual([
      ["root:task:plan-0", "Current", "completed", "root"], ["child:task:todos-0", "Child work", "in_progress", "child"],
    ]);
  });

  test("attaches the captured agentTeam through both bootstrap and family host seams", async () => {
    const root = session("root", "root-native"), child = session("child", "child-native", "root");
    const plan = root.call("update_plan", { plan: [{ step: "Captured work", status: "pending" }] });
    root.result(plan.callId, "Plan updated");
    const { service, paseo } = harness([root, child]), routes = new UiRoutes(service);
    const bootstrap = await routes.handle("bootstrap", { agentId: "root" }, paseo) as {
      sessions: Array<{ id: string; projectionValues: { agentTeam: { tasks: Array<{ subject: string }> } } }>;
    };
    expect(bootstrap.sessions.find((row) => row.id === "root")?.projectionValues.agentTeam.tasks[0].subject).toBe("Captured work");
    const family = await routes.handle("family", { agentId: "root" }, paseo) as typeof bootstrap.sessions;
    expect(family.find((row) => row.id === "child")?.projectionValues.agentTeam.tasks[0].subject).toBe("Captured work");
    routes.clear();
  });
});
