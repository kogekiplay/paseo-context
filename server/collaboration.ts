import type { CollaborationRecord } from "../shared/contracts";
import type { Message } from "./normalize";
import { detachSlice, parseArgs, printable, record, stringBytes, text, type RecordValue } from "./value";
import { askOf, workflowLabel, type EmitWorkflow } from "./workflow";
import { notePlan, type TaskStatus } from "./workflow-plan";
import { dispatchedChildId, dispatchAcknowledged, goalToolEvent, resultHeader, taskAcknowledged, workflowResultFailed } from "./workflow-result";

export interface CapturedTask {
  id: string; subject: string; description: string; status: TaskStatus; blockedBy: string[];
  owner?: string; group?: string; writeScopes?: string[]; unkeyed?: boolean;
}
interface TaskUpdate {
  id: string; subject?: string; description?: string; status?: TaskStatus | "deleted";
  blockedBy?: string[]; addBlockedBy?: string[]; removeBlockedBy?: string[];
  owner?: string; group?: string; writeScopes?: string[]; unkeyed?: boolean;
}
export interface NativeChild {
  sessionId: string; title: string; time: number; status: string;
  mode?: "one-shot" | "continuable";
}
export type FleetRecord = Omit<CollaborationRecord, "agentId"> & {
  from?: string; textLength?: number; contentKind?: "message" | "report" | "delegation-result";
};
interface Pending {
  nodeId: number; title: string; tool: string; kind: "delegation" | "message" | "task" | "wait" | "goal";
  updates?: TaskUpdate[]; snapshot?: string; mode?: NativeChild["mode"]; synchronous?: boolean;
  dispatched?: boolean; childSessionId?: string; objective?: string;
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

  get residentBytes() {
    const stringsBytes = (values?: string[]) => values?.reduce((n, value) => n + 8 + stringBytes(value), 32) ?? 0;
    const taskBytes = (task: TaskUpdate) => 256 + stringBytes(task.id) + stringBytes(task.subject) + stringBytes(task.description)
      + stringBytes(task.owner) + stringsBytes(task.blockedBy) + stringsBytes(task.writeScopes)
      + stringsBytes(task.addBlockedBy) + stringsBytes(task.removeBlockedBy);
    let bytes = 320;
    for (const row of this.records) bytes += 192 + stringBytes(row.id) + stringBytes(row.title) + stringBytes(row.to)
      + stringBytes(row.from) + stringBytes(row.taskId) + stringsBytes(row.blockedBy);
    for (const child of this.children.values()) bytes += 176 + stringBytes(child.sessionId) + stringBytes(child.title);
    for (const task of this.tasks.values()) bytes += taskBytes(task);
    for (const [id, call] of this.pending) {
      bytes += 224 + stringBytes(id) + stringBytes(call.title) + stringBytes(call.tool)
        + stringBytes(call.objective) + stringBytes(call.childSessionId);
      for (const task of call.updates ?? []) bytes += taskBytes(task);
    }
    return bytes;
  }

  private tasksOf(args: RecordValue, tool: string, nodeId: number): Pick<Pending, "updates" | "snapshot"> {
    const list = Array.isArray(args.plan) ? args.plan : Array.isArray(args.todos) ? args.todos : null;
    if (list) {
      const group = tool.includes("todo") ? "todos" : "plan";
      const rows = list.map(record);
      const explicitIds = new Set(rows.map((row) => taskId(row.id)));
      return { snapshot: group, updates: rows.map((row, index) => {
        const explicit = taskId(row.id);
        let id = explicit || `${group}-${index}`;
        if (!explicit) while (explicitIds.has(id)) id += "-unnamed";
        return { id, unkeyed: !explicit, group, owner: "@self",
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
  private applyTasks(pending: Pending, result: RecordValue = {}, content = "", emit?: EmitWorkflow) {
    if (pending.snapshot) {
      if (emit) notePlan(this.tasks.values(), pending.updates ?? [], pending.snapshot, emit);
      for (const [id, task] of this.tasks) if (task.group === pending.snapshot) this.tasks.delete(id);
    }
    const returned = record(result.task);
    const returnedId = taskId(result.taskId ?? result.task_id ?? returned.id ?? result.id)
      || detachSlice(/Task\s+#(\d+)\s+created/i.exec(content)?.[1] ?? "");
    const entry = pending.updates?.length === 1
      ? this.records.find((r) => r.nodeId === pending.nodeId && r.kind === "task") : undefined;
    for (const update of pending.updates ?? []) {
      const id = update.id.startsWith("capture-") && returnedId ? returnedId : update.id;
      if (update.status === "deleted") { this.tasks.delete(id); continue; }
      const previous = this.tasks.get(id);
      const blockedBy = new Set(update.blockedBy ?? previous?.blockedBy ?? []);
      for (const dependency of update.addBlockedBy ?? []) blockedBy.add(dependency);
      for (const dependency of update.removeBlockedBy ?? []) blockedBy.delete(dependency);
      const scopes = update.writeScopes ?? previous?.writeScopes;
      const subject = update.subject ?? previous?.subject ?? id;
      const status = update.status ?? previous?.status ?? "pending";
      const group = update.group ?? previous?.group;
      this.tasks.set(id, { id, subject, description: update.description ?? previous?.description ?? "", status,
        blockedBy: [...blockedBy], ...(previous?.owner === undefined ? {} : { owner: previous.owner }),
        ...(update.owner === undefined ? {} : { owner: update.owner }),
        ...(group ? { group, unkeyed: update.unkeyed ?? previous?.unkeyed } : {}),
        ...(scopes ? { writeScopes: scopes } : {}) });
      if (emit && !group) {
        const creating = (pending.tool === "task_create" || pending.tool === "taskcreate") && !previous;
        const completing = previous && previous.status !== "completed" && status === "completed";
        if (creating || completing) emit({ kind: creating ? "team-task-create" : "team-task-complete",
          title: workflowLabel(subject), count: 1 });
      }
      if (entry) entry.taskId = id;
    }
  }
  apply(message: Message, nodeId: number, at: number, emit?: EmitWorkflow) {
    if (message.category === "calls") {
      const tool = (message.tool ?? "").split(".").at(-1)!.replace(/^mcp__.*?__/, "").toLowerCase();
      if (emit && ["ask_user_question", "askuserquestion", "ask_question", "request_user_input"].includes(tool)) {
        const event = askOf(message.args ?? parseArgs(message.text));
        if (event) emit(event);
      }
      const kind = message.delegation || /(?:spawn_agent|create_agent|delegate|^task$|^agent$)/.test(tool) ? "delegation"
        : /(?:send_input|send_message|sendmessage|agent_send|message_agent)/.test(tool) ? "message"
        : /(?:task_create|taskcreate|task_update|taskupdate|update_plan|todowrite)/.test(tool) ? "task"
        : /^(?:create_goal|update_goal|complete_goal)$/.test(tool) ? "goal"
        : /^(?:wait|wait_agent|wait_agents)$/.test(tool) ? "wait" : null;
      if (!kind) return;
      const args = message.args ?? parseArgs(message.text);
      const title = text(message.delegation?.description ?? args.message ?? args.content ?? args.prompt ?? args.description ?? args.subject ?? args.explanation) || tool;
      const preview = detachSlice(title, 500);
      const childSessionId = message.delegation ? dispatchedChildId({ childSessionId: message.delegation.childId }) : "";
      const to = childSessionId || text(args.agent_id ?? args.recipient ?? args.to ?? args.id ?? args.target)
        || (args.type === "broadcast" ? "*" : "");
      const pending: Pending = { nodeId, title: preview, tool, kind,
        ...(kind === "task" ? this.tasksOf(args, tool, nodeId) : {}),
        ...(kind === "goal" ? { objective: workflowLabel(text(args.objective)) } : {}),
        ...(kind === "delegation" ? { mode: args.mode === "one-shot" || args.mode === "continuable" ? args.mode
          : tool === "task" || tool === "agent" ? "one-shot" : "continuable",
          ...(childSessionId ? { childSessionId } : {}),
          synchronous: !message.delegation && (tool === "task" || tool === "agent") && args.run_in_background !== true } : {}) };
      if (kind !== "wait" && kind !== "goal") {
        const status = taskStatus(args.status);
        this.records.push({ id: `${nodeId}`, nodeId, time: at, kind, title: preview, to,
          taskId: taskId(args.taskId ?? args.task_id), status: status === "deleted" ? "unknown" : status ?? "unknown",
          blockedBy: strings(args.blockedBy), textLength: title.length,
          ...(kind === "message" ? { contentKind: "message" as const } : {}) });
      }
      if (message.delegation?.running && childSessionId) {
        pending.dispatched = true;
        emit?.({ kind: "agent", title: workflowLabel(preview), count: 1, agent: childSessionId });
      }
      if (message.callId) this.pending.set(message.callId, pending);
      else if (kind === "task") this.applyTasks(pending);
    } else if (message.category === "tool" && message.callId && !message.pending) {
      const pending = this.pending.get(message.callId);
      if (!pending) return;
      const result = parseArgs(message.text), call = this.records.find((r) => r.nodeId === pending.nodeId);
      const header = resultHeader(message.text);
      const failed = message.error === true || workflowResultFailed(result, header);
      if (failed && call) call.status = "failed";
      if (pending.kind === "delegation" && !failed) {
        const id = dispatchedChildId(result, header);
        if (id) {
          this.children.set(id, { sessionId: id, title: detachSlice(pending.title, 180), time: at, status: "unknown", mode: pending.mode });
          if (call) call.to = id;
        }
        const child = id || pending.childSessionId;
        if (!pending.dispatched && (child || message.resultConfirmed || dispatchAcknowledged(result, header))) {
          emit?.({ kind: "agent", title: workflowLabel(pending.title), count: 1, ...(child ? { agent: child } : {}) });
        }
      }
      if (pending.kind === "task" && !failed && (message.resultConfirmed || taskAcknowledged(result, header, !!pending.snapshot, pending.tool))) {
        this.applyTasks(pending, result, header, emit);
      }
      if (pending.kind === "goal" && !failed && emit) {
        const event = goalToolEvent(pending.tool, pending.objective, result, header, message.resultConfirmed);
        if (event) emit(event);
      }
      if (pending.kind === "wait" || pending.kind === "delegation") {
        const reports = agentReportsOf(message.text);
        const synchronous = pending.synchronous && call?.to && !failed && result.isAsync !== true
          && result.status !== "running" && result.status !== "pending";
        const delegationResult = synchronous && reports.length === 0;
        if (delegationResult) {
          reports.push({ from: call.to, text: delegationTextOf(message.text), status: "completed" });
        }
        for (const report of reports) {
          this.records.push({ id: `${nodeId}:${report.from}`, nodeId, time: at, kind: "report", from: report.from,
            title: detachSlice(report.text, 500), to: "", taskId: "", status: report.status, blockedBy: [],
            textLength: report.text.length, contentKind: delegationResult ? "delegation-result" : "report" });
          const child = this.children.get(report.from);
          if (child) child.status = report.status;
        }
      }
      this.pending.delete(message.callId);
      return failed;
    }
  }
}
