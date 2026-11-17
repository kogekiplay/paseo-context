import type { CollaborationRecord } from "../shared/contracts";
import type { Message } from "./normalize";
import { parseArgs, printable, record, text, type RecordValue } from "./value";

type TaskStatus = "pending" | "in_progress" | "completed";
export interface CapturedTask {
  id: string; subject: string; description: string; status: TaskStatus; blockedBy: string[];
  owner?: string; group?: string; writeScopes?: string[];
}
interface TaskUpdate {
  id: string; subject?: string; description?: string; status?: TaskStatus | "deleted";
  blockedBy?: string[]; addBlockedBy?: string[]; removeBlockedBy?: string[];
  owner?: string; group?: string; writeScopes?: string[];
}
export interface NativeChild {
  sessionId: string; title: string; time: number; status: string;
  mode?: "one-shot" | "continuable";
}
export type FleetRecord = Omit<CollaborationRecord, "agentId"> & {
  from?: string; textLength?: number; contentKind?: "message" | "report" | "delegation-result";
};
interface Pending {
  nodeId: number; title: string; tool: string; kind: "delegation" | "message" | "task" | "wait";
  updates?: TaskUpdate[]; snapshot?: string; mode?: NativeChild["mode"]; synchronous?: boolean;
}
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const taskStatus = (value: unknown): TaskUpdate["status"] =>
  value === "pending" || value === "in_progress" || value === "completed" || value === "deleted" ? value : undefined;
const taskId = (value: unknown): string => typeof value === "number" ? String(value) : text(value);
const childId = (value: RecordValue): string =>
  text(value.agent_id ?? value.agentId ?? value.session_id ?? value.sessionId);
export function delegationTextOf(content: string): string {
  const value = parseArgs(content);
  return printable(value.result ?? value.output ?? value.message ?? value.content) || content;
}

/** Only explicit terminal agent states are reports; tool acknowledgements are not. */
export function agentReportsOf(content: string): Array<{ from: string; text: string; status: "completed" | "failed" }> {
  const result = parseArgs(content), reports: Array<{ from: string; text: string; status: "completed" | "failed" }> = [];
  for (const [from, value] of Object.entries(record(result.status))) {
    const state = record(value);
    if (state.completed !== undefined) reports.push({ from, text: printable(state.completed), status: "completed" });
    else if (state.errored !== undefined || state.error !== undefined) {
      reports.push({ from, text: printable(state.errored ?? state.error), status: "failed" });
    }
  }
  const from = childId(result);
  if (from && (result.status === "completed" || result.status === "failed")) {
    reports.push({ from, text: printable(result.result ?? result.output ?? result.message ?? result.error),
      status: result.status === "failed" ? "failed" : "completed" });
  }
  return reports;
}

export class CollaborationLedger {
  readonly records: FleetRecord[] = [];
  readonly children = new Map<string, NativeChild>();
  readonly tasks = new Map<string, CapturedTask>();
  private pending = new Map<string, Pending>();

  private tasksOf(args: RecordValue, tool: string, nodeId: number): Pick<Pending, "updates" | "snapshot"> {
    const list = Array.isArray(args.plan) ? args.plan : Array.isArray(args.todos) ? args.todos : null;
    if (list) {
      const group = tool.includes("todo") ? "todos" : "plan";
      return { snapshot: group, updates: list.map((value, index) => {
        const row = record(value);
        return { id: taskId(row.id) || `${group}-${index}`, group, owner: "@self",
          subject: text(row.step ?? row.content ?? row.subject ?? row.description),
          description: text(row.description), status: taskStatus(row.status) ?? "pending",
          blockedBy: strings(row.blockedBy), writeScopes: strings(row.writeScopes) };
      }) };
    }
    return { updates: [{ id: taskId(args.taskId ?? args.task_id ?? args.id) || `capture-${nodeId}`,
      ...(args.subject !== undefined ? { subject: text(args.subject) } : {}),
      ...(args.description !== undefined ? { description: text(args.description) } : {}),
      ...(taskStatus(args.status) ? { status: taskStatus(args.status) } : {}),
      ...(args.blockedBy !== undefined ? { blockedBy: strings(args.blockedBy) } : {}),
      ...(args.addBlockedBy !== undefined ? { addBlockedBy: strings(args.addBlockedBy) } : {}),
      ...(args.removeBlockedBy !== undefined ? { removeBlockedBy: strings(args.removeBlockedBy) } : {}),
      ...(args.owner !== undefined ? { owner: text(args.owner) } : {}),
      ...(args.writeScopes !== undefined ? { writeScopes: strings(args.writeScopes) } : {}) }] };
  }
  private applyTasks(pending: Pending, result: RecordValue = {}, content = "") {
    if (pending.snapshot) {
      for (const [id, task] of this.tasks) if (task.group === pending.snapshot) this.tasks.delete(id);
    }
    const returned = record(result.task);
    const returnedId = taskId(result.taskId ?? result.task_id ?? returned.id ?? result.id)
      || /Task\s+#(\d+)\s+created/i.exec(content)?.[1];
    for (const update of pending.updates ?? []) {
      const id = update.id.startsWith("capture-") && returnedId ? returnedId : update.id;
      if (update.status === "deleted") { this.tasks.delete(id); continue; }
      const previous = this.tasks.get(id);
      const blockedBy = new Set(update.blockedBy ?? previous?.blockedBy ?? []);
      for (const dependency of update.addBlockedBy ?? []) blockedBy.add(dependency);
      for (const dependency of update.removeBlockedBy ?? []) blockedBy.delete(dependency);
      const scopes = update.writeScopes ?? previous?.writeScopes;
      this.tasks.set(id, { id, subject: update.subject ?? previous?.subject ?? id,
        description: update.description ?? previous?.description ?? "", status: update.status ?? previous?.status ?? "pending",
        blockedBy: [...blockedBy], ...(previous?.owner === undefined ? {} : { owner: previous.owner }),
        ...(update.owner === undefined ? {} : { owner: update.owner }),
        ...(update.group ? { group: update.group } : {}),
        ...(scopes ? { writeScopes: scopes } : {}) });
      const entry = this.records.find((r) => r.nodeId === pending.nodeId && r.kind === "task");
      if (entry && pending.updates?.length === 1) entry.taskId = id;
    }
  }
  apply(message: Message, nodeId: number, at: number) {
    const tool = (message.tool ?? "").split(".").at(-1)!.replace(/^mcp__.*?__/, "").toLowerCase();
    const args = message.args ?? parseArgs(message.text);
    if (message.category === "calls") {
      const kind = /(?:spawn_agent|create_agent|delegate|^task$|^agent$)/.test(tool) ? "delegation"
        : /(?:send_input|send_message|sendmessage|agent_send|message_agent)/.test(tool) ? "message"
        : /(?:task_create|taskcreate|task_update|taskupdate|update_plan|todowrite)/.test(tool) ? "task"
        : /^(?:wait|wait_agent|wait_agents)$/.test(tool) ? "wait" : null;
      if (!kind) return;
      const title = text(args.message ?? args.content ?? args.prompt ?? args.description ?? args.subject ?? args.explanation) || tool;
      const to = text(args.agent_id ?? args.recipient ?? args.to ?? args.id ?? args.target) || (args.type === "broadcast" ? "*" : "");
      const pending: Pending = { nodeId, title: title.slice(0, 500), tool, kind,
        ...(kind === "task" ? this.tasksOf(args, tool, nodeId) : {}),
        ...(kind === "delegation" ? { mode: args.mode === "one-shot" || args.mode === "continuable" ? args.mode
          : tool === "task" || tool === "agent" ? "one-shot" : "continuable",
          synchronous: (tool === "task" || tool === "agent") && args.run_in_background !== true } : {}) };
      if (kind !== "wait") {
        const status = taskStatus(args.status);
        this.records.push({ id: `${nodeId}`, nodeId, time: at, kind, title: title.slice(0, 500), to,
          taskId: taskId(args.taskId ?? args.task_id), status: status === "deleted" ? "unknown" : status ?? "unknown",
          blockedBy: strings(args.blockedBy), textLength: title.length,
          ...(kind === "message" ? { contentKind: "message" as const } : {}) });
      }
      if (message.callId) this.pending.set(message.callId, pending);
      else if (kind === "task") this.applyTasks(pending);
    } else if (message.category === "tool" && message.callId) {
      const pending = this.pending.get(message.callId);
      if (!pending) return;
      const result = parseArgs(message.text), call = this.records.find((r) => r.nodeId === pending.nodeId);
      if (message.error && call) call.status = "failed";
      if (pending.kind === "delegation" && !message.error) {
        const id = childId(result)
          || /(?:agentId|agent_id|session_id)["':=\s]+([a-zA-Z0-9_-]{8,})/.exec(message.text)?.[1] || "";
        if (id && /^[a-zA-Z0-9_-]+$/.test(id)) {
          this.children.set(id, { sessionId: id, title: pending.title.slice(0, 180), time: at, status: "unknown", mode: pending.mode });
          if (call) call.to = id;
        }
      }
      if (pending.kind === "task" && !message.error) this.applyTasks(pending, result, message.text);
      if (pending.kind === "wait" || pending.kind === "delegation") {
        const reports = agentReportsOf(message.text);
        const synchronous = pending.synchronous && call?.to && !message.error && result.isAsync !== true
          && result.status !== "running" && result.status !== "pending";
        if (synchronous && reports.length === 0) {
          reports.push({ from: call.to, text: delegationTextOf(message.text), status: "completed" });
        }
        for (const report of reports) {
          this.records.push({ id: `${nodeId}:${report.from}`, nodeId, time: at, kind: "report", from: report.from,
            title: report.text.slice(0, 500), to: "", taskId: "", status: report.status, blockedBy: [],
            textLength: report.text.length, contentKind: synchronous && agentReportsOf(message.text).length === 0 ? "delegation-result" : "report" });
          const child = this.children.get(report.from);
          if (child) child.status = report.status;
        }
      }
      this.pending.delete(message.callId);
    }
  }
}
