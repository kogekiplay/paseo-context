import { detachSlice, record, text, type RecordValue } from "./value";
import { goalOf, type WorkflowEvent } from "./workflow";

// Only inspect the tool's leading acknowledgement, never arbitrary text in a
// subsequent agent report or the original contents of a large result.
export const resultHeader = (value: string) => detachSlice(value, 512).trimStart();

const denial = [
  /^Tool (?:execution|call) (?:failed|denied|rejected)\b/i,
  /^(?:Error|Failed|Failure|Denied|Rejected)(?:[ \t]*[:.!]|\s+to\b|\s*$)/i,
  /^(?:(?:Permission|Access|Request|Operation) (?:denied|rejected)|No (?:permission|active goal))\b/i,
  /^(?:Cannot|Could not|Unable to|Not authorized|Not allowed)\b/i,
  /^(?:(?:Maximum|Max) (?:agent|subagent)|(?:Agent|Task) (?:depth|limit))\b/i,
  /^(?:A goal is already active|(?:Task|Goal)(?: #?[\w-]+)? (?:not found|does not exist|already exists))\b/i,
];
const failedStatus = new Set(["failed", "error", "errored", "denied", "rejected", "canceled", "cancelled"]);
export function workflowResultFailed(result: RecordValue, header: string) {
  if (result.isError === true || result.is_error === true || result.success === false || result.ok === false
    || !!result.error || failedStatus.has(text(result.status).toLowerCase())
    || denial.some((pattern) => pattern.test(header))) return true;
  const message = text(result.message);
  if (!message) return false;
  const summary = resultHeader(message);
  return denial.some((pattern) => pattern.test(summary));
}

const acknowledged = (result: RecordValue) => result.success === true || result.ok === true
  || /^(?:ok|success|succeeded)$/.test(text(result.status).toLowerCase());

const agentStarted = /^(?:Async )?(?:Agent|Subagent) (?:spawned|launched|started|dispatched) successfully[.!]?(?:\r?\n|$)/i;
export function dispatchAcknowledged(result: RecordValue, header: string) {
  return acknowledged(result) || /^(?:spawned|started|accepted|dispatched|running|completed)$/.test(text(result.status).toLowerCase())
    || agentStarted.test(header);
}

export function dispatchedChildId(result: RecordValue, header = "") {
  const value = text(result.agent_id ?? result.agentId ?? result.session_id ?? result.sessionId
    ?? result.child_session_id ?? result.childSessionId)
    || /^(?:agentId|agent_id|session_id):[ \t]*([a-zA-Z0-9_-]+)(?=\s|$)/im.exec(header)?.[1] || "";
  return /^[a-zA-Z0-9_-]+$/.test(value) ? detachSlice(value) : "";
}

export function taskAcknowledged(result: RecordValue, header: string, snapshot: boolean, tool: string) {
  if (acknowledged(result)) return true;
  if (snapshot) return /^(?:Plan updated|Updated|Todos? (?:updated|have been modified successfully))\b/i.test(header);
  const id = record(result.task).id ?? result.taskId ?? result.task_id ?? result.id;
  if ((typeof id === "number" && Number.isFinite(id)) || text(id).trim()) return true;
  return tool === "task_create" || tool === "taskcreate"
    ? /^Task\s+#\d+\s+created\b/i.test(header)
    : /^(?:Updated task #\d+|Task\s+#\d+\s+(?:updated|completed))\b/i.test(header);
}

export function goalToolEvent(tool: string, objective: string | undefined, result: RecordValue,
  header: string, confirmed: boolean | undefined): WorkflowEvent | undefined {
  const goal = record(result.goal ?? result);
  const status = text(goal.status).toLowerCase();
  if (goal !== result && workflowResultFailed(goal, "")) return undefined;
  const completed = status === "complete" || status === "completed";
  const creating = tool === "create_goal";
  const confirmation = creating ? /^Goal created(?: successfully)?[.!]?(?:\r?\n|$)/i
    : /^Goal (?:completed|marked (?:as )?complete)(?: successfully)?[.!]?(?:\r?\n|$)/i;
  const explicit = completed || confirmation.test(header);
  if (tool === "update_goal" && !explicit) return undefined;
  if (!creating && /^(?:active|pending|paused|blocked|budget_limited|in_progress)$/.test(status)) return undefined;
  const goalResult = creating && (!!text(goal.objective) || !!text(goal.id ?? goal.goalId ?? goal.goal_id));
  if (!explicit && !goalResult && !confirmed && !acknowledged(result)) return undefined;
  return goalOf(creating ? "create" : "complete", goal.objective ?? objective)
    ?? { kind: creating ? "goal-create" : "goal-complete", title: "", count: 1 };
}
