import { detachSlice, record, text, type RecordValue } from "./value";
import { goalOf, type WorkflowEvent } from "./workflow";
import { antigravityConversationId } from "./antigravity-log";

// Only inspect the tool's leading acknowledgement, never arbitrary text in a
// subsequent agent report or the original contents of a large result.
export const resultHeader = (value: string) => detachSlice(value, 512).trimStart();

const RESULT_PREFIX = 2 * 1024;
const JSON_LIMIT = 512 * 1024;
const WORKFLOW_FIELDS = new Set(["agentId", "agent_id", "sessionId", "session_id", "childSessionId", "child_session_id",
  "conversationId", "conversation_id", "taskId", "task_id", "task", "goal", "status", "success", "ok",
  "error", "isError", "is_error", "result", "output", "message"]);

export function prefixedWorkflowResult(value: string, accept?: (candidate: RecordValue) => boolean): RecordValue {
  const prefix = detachSlice(value, RESULT_PREFIX);
  const first = prefix.length - prefix.trimStart().length;
  const relevant = (result: RecordValue) => Object.keys(result).some((key) => WORKFLOW_FIELDS.has(key));
  const legacy = (result: RecordValue) => ["content", "objective", "id"].some((key) => Object.hasOwn(result, key));
  if (prefix[first] === "{" && value.length <= JSON_LIMIT && Buffer.byteLength(value, "utf8") <= JSON_LIMIT) {
    try {
      const parsed = record(JSON.parse(value));
      return accept?.(parsed) || relevant(parsed) || legacy(parsed) ? parsed : {};
    } catch {}
  }
  // The CLI can lead with a short description or a set of key=value lines.
  // Look for JSON near the beginning and cap the work to extract it.
  let budget = JSON_LIMIT;
  let through = 0;
  let fallback: RecordValue | undefined;
  for (const match of prefix.matchAll(/\{(?=\s*["}])/g)) {
    const start = match.index;
    if (start < through) continue;
    let depth = 0, quoted = false;
    for (let index = start; index < value.length && budget-- > 0; index++) {
      const char = value[index];
      if (char === '"') quoted = !quoted;
      else if (quoted && char === "\\") { index++; budget--; }
      else if (!quoted && char === "{") depth++;
      else if (!quoted && char === "}" && --depth === 0) {
        try {
          const json = value.slice(start, index + 1);
          if (Buffer.byteLength(json, "utf8") > JSON_LIMIT) break;
          const candidate = record(JSON.parse(json));
          if (accept?.(candidate) || !accept && relevant(candidate)) return candidate;
          if (!fallback && (relevant(candidate) || start === first && legacy(candidate))) fallback = candidate;
          through = index + 1;
          break;
        }
        catch { break; }
      }
    }
    if (budget <= 0) break;
  }
  return fallback ?? {};
}

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

export function dispatchedChildId(result: RecordValue, header = "", nativeAntigravity = false) {
  if (nativeAntigravity) {
    const id = text(result.conversationId ?? result.conversation_id)
      || /^conversation(?:Id|_id):[ \t]*([a-zA-Z0-9_-]+)(?=\s|$)/im.exec(header)?.[1] || "";
    return id.length === 36 ? antigravityConversationId(id) ?? "" : "";
  }
  const value = text(result.agent_id ?? result.agentId ?? result.session_id ?? result.sessionId
    ?? result.child_session_id ?? result.childSessionId)
    || /^(?:agentId|agent_id|session_id):[ \t]*([a-zA-Z0-9_-]+)(?=\s|$)/im.exec(header)?.[1] || "";
  const id = detachSlice(value, 512);
  return value.length === id.length && /^[a-zA-Z0-9_-]+$/.test(id) ? id : "";
}

export function taskAcknowledged(result: RecordValue, header: string, snapshot: boolean, tool: string) {
  if (acknowledged(result)) return true;
  if (tool === "update_steps") return /^OK(?:\s|$)/.test(header);
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
