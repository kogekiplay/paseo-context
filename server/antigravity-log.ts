import type { ProviderTiming, Usage } from "../shared/contracts";
import type { Message } from "./normalize";
import { detachSlice, parseArgs, printable, record, stringBytes, text, timestamp, type RecordValue } from "./value";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function conversationUuid(id: unknown): string | null {
  return typeof id === "string" && id.length === 36 && UUID.test(id) ? detachSlice(id.toLowerCase()) : null;
}

export function antigravityPersistenceId(value: unknown): string | null {
  const envelope = record(value), data = record(envelope.data);
  return envelope.version === 1 ? conversationUuid(data.sessionId ?? data.conversationId) : null;
}

export function antigravityConversationId(handle: string | null): string | null {
  if (!handle?.startsWith("plugin:")) return conversationUuid(handle);
  try {
    return antigravityPersistenceId(JSON.parse(handle.slice("plugin:".length)));
  } catch {
    return null;
  }
}

export function stripAntigravityEnvelope(body: string): string {
  const head = detachSlice(body, 2048);
  const prefix = /(?:Created At:[^\r\n]*\r?\n(?:Completed At:[^\r\n]*\r?\n)?|A pre-tool hook changed the arguments of this tool call before it ran\.[^\r\n]*(?:\r?\n)*)/y;
  let offset = 0;
  while (prefix.test(head)) {
    if (prefix.lastIndex === head.length && head.length < body.length && !head.endsWith("\n")) break;
    offset = prefix.lastIndex;
  }
  return body.slice(offset);
}

export type ToolTimes = { start?: number; end?: number };
export type AntigravityStep =
  | { type: "USER_INPUT"; at?: number }
  | { type: "PLANNER_RESPONSE" | "CHECKPOINT"; at?: number; usageAt?: number; usage: Partial<Usage>;
      timing?: ProviderTiming; responseId?: string }
  | { type: "GENERIC"; at?: number; tool?: string; times: ToolTimes };

export function antigravityStepIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const ARGUMENT_ALIASES = {
  CommandLine: "command", Path: "file_path", Target: "old_string", Replacement: "new_string",
  Content: "content", StartLine: "offset", EndLine: "limit", Cwd: "workdir",
  Prompt: "prompt", Role: "description", Recipient: "recipient", Message: "message",
} as const;

export function antigravityArgs(value: unknown): RecordValue {
  const args = { ...parseArgs(value) };
  for (const [from, to] of Object.entries(ARGUMENT_ALIASES)) {
    if (args[to] === undefined && args[from] !== undefined) args[to] = args[from];
  }
  return args;
}

export function antigravityMessages(row: RecordValue, metadataOnly = false): Message[] {
  const body = printable(row.content);
  const images = Array.isArray(row.media) ? row.media.length : 0;
  switch (row.type) {
    case "USER_INPUT":
      return row.source && row.source !== "USER_EXPLICIT" ? []
        : [{ category: "user", title: "User input", text: body, block: -1, images }];
    case "PLANNER_RESPONSE": {
      const thinking = printable(row.thinking);
      const messages: Message[] = [];
      if (thinking) messages.push({ category: "reasoning", title: "Reasoning", text: thinking, block: -2 });
      if (body || images) messages.push({ category: "assistant", title: "Assistant", text: body, block: -1, images });
      if (!Array.isArray(row.tool_calls)) return messages;
      for (const [block, value] of row.tool_calls.entries()) {
        const call = record(value), tool = text(call.name);
        if (!tool && call.args === undefined && !metadataOnly) continue;
        messages.push({ category: "calls", title: tool || "Tool call", text: metadataOnly ? "" : printable(call.args),
          tool, args: antigravityArgs(call.args), block });
      }
      return messages;
    }
    case "GENERIC":
      return [{ category: "tool", title: "Tool result", text: body || printable(row.error), block: -1,
        images, error: !!row.error || row.status === "ERROR", pending: row.status === "RUNNING" }];
    case "SYSTEM_MESSAGE":
      return [{ category: "inject", title: "System message", text: body, block: -1 }];
    case "CHECKPOINT":
      return [{ category: "inject", title: "Compaction summary", text: body, block: -1 }];
    case "ERROR_MESSAGE":
      return [{ category: "inject", title: "Error", text: printable(row.error) || body, error: true, block: -1 }];
    default:
      return [];
  }
}

function interval(times: ToolTimes | undefined): times is Required<ToolTimes> {
  return times?.start !== undefined && times.end !== undefined && times.end >= times.start;
}

export function mergeAntigravityUsage(base: Partial<Usage> | undefined, override: Partial<Usage> | undefined): Partial<Usage> {
  if (!override || !Object.keys(override).length) return { ...base };
  const out: Partial<Usage> = { ...base };
  if (override.input !== undefined || override.cacheRead !== undefined || override.cacheWrite !== undefined) {
    delete out.input;
    delete out.cacheRead;
    delete out.cacheWrite;
  }
  return { ...out, ...override };
}

export function antigravityToolTimes(body: string, exact?: ToolTimes): ToolTimes {
  if (interval(exact)) return exact;
  // These two leading lines belong to the CLI's result envelope. The body
  // can itself contain other tool results or arbitrary timestamped output.
  const header = /^Created At:[ \t]*([^\r\n]+)\r?\nCompleted At:[ \t]*([^\r\n]+)/.exec(detachSlice(body, 2048));
  if (header) {
    const start = timestamp(header[1]), end = timestamp(header[2]);
    if (start > 0 && end >= start) return { start, end };
  }
  if (exact?.start !== undefined && exact.end !== undefined && exact.end < exact.start) return { start: exact.start };
  return exact ?? {};
}

const tailOf = (body: string) => detachSlice(body.slice(-2048));
const exitFooter = /^(?:Command|Process) exited with code[ \t]+(-?\d+)[ \t]*\.?[ \t]*$/gim;

function footerExitCode(body: string) {
  let code: string | undefined;
  for (const match of tailOf(body).matchAll(exitFooter)) code = match[1];
  return code;
}

export function commandExitCode(body: string, antigravity = false) {
  if (antigravity) {
    const head = detachSlice(stripAntigravityEnvelope(body), 2048).trimStart();
    return /^Exit Code:[ \t]*(-?\d+)[ \t]*(?:\r?\n|$)/i.exec(head)?.[1] ?? footerExitCode(body);
  }
  const pattern = /(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?[=: ]+|Process exited with code )(-?\d+)/i;
  const match = pattern.exec(body);
  const code = match ? detachSlice(match[1]) : undefined;
  // V8 keeps the last successful regular expression input alive.
  /^/.test("");
  return code;
}

export function antigravityBackgroundTask(body: string) {
  const head = detachSlice(stripAntigravityEnvelope(body), 2048).trimStart();
  return /^Tool is running as a background task with task id:[ \t]*([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)(?=\s|$)/i.exec(head)?.[1];
}

export function antigravityTaskResult(body: string, action: string, taskId: string) {
  if (action !== "status" && action !== "kill") return null;
  const head = detachSlice(stripAntigravityEnvelope(body), 2048).trimStart();
  let state = "", code: string | undefined, structured = false;
  for (const line of head.split(/\r?\n/)) {
    const task = /^Task(?: ID)?:[ \t]*(.*)$/i.exec(line);
    const status = /^Status:[ \t]*(.+)$/i.exec(line);
    const exit = /^Exit Code:[ \t]*(-?\d+)[ \t]*$/i.exec(line);
    if (task && task[1].trim().replace(/^"([^"]*)"$/, "$1") !== taskId) return null;
    if (status) state = status[1].trim().toLowerCase();
    if (exit) code = exit[1];
    if (!task && !status && !exit) break;
    structured = true;
  }
  const failure = /^(?:failed|error|cancell?ed|killed|terminated|aborted|timed[ _]out|timeout)$/;
  if (!structured) {
    const terminated = /^(?:Task "([^"]+)"[ \t]+)?(cancell?ed|killed|terminated|aborted|timed[ _]out|timeout)\.[ \t]*(?:\r?\n|$)/i.exec(head);
    if (terminated) {
      if (terminated[1] && terminated[1] !== taskId) return null;
      state = terminated[2].toLowerCase();
    }
    code = footerExitCode(body);
  }
  if (/^(?:running|in[ _-]progress|pending|queued)$/.test(state)) return { status: "running" as const, exit: null };
  const exit = code === undefined ? null : Number(code);
  if (failure.test(state) || exit !== null && exit !== 0) return { status: "failed" as const, exit };
  return exit === 0 || /^(?:done|completed|succeeded)$/.test(state) ? { status: "completed" as const, exit } : null;
}

export class AntigravityCalls {
  private pending: string[] = [];
  private cursor = 0;
  private lastPlannerId = "";

  get residentBytes() {
    let bytes = 64 + stringBytes(this.lastPlannerId);
    for (const id of this.pending) bytes += 8 + stringBytes(id);
    return bytes;
  }

  link(row: RecordValue, messages: Message[], line: number, step?: AntigravityStep) {
    const hasCalls = messages.some((message) => message.category === "calls");
    const plannerId = row.type === "PLANNER_RESPONSE"
      ? (step?.type === "PLANNER_RESPONSE" ? step.responseId : undefined) || text(row.response_id) || ""
      : "";
    const samePlanner = row.type === "PLANNER_RESPONSE" && !hasCalls && Boolean(plannerId) && plannerId === this.lastPlannerId;
    if (this.cursor === this.pending.length || row.type === "USER_INPUT" || row.type === "ERROR_MESSAGE"
      || row.type === "CHECKPOINT" || (row.type === "PLANNER_RESPONSE" && !samePlanner)) {
      this.pending = [];
      this.cursor = 0;
    }
    if (row.type === "PLANNER_RESPONSE") this.lastPlannerId = plannerId;
    else if (row.type !== "GENERIC") this.lastPlannerId = "";
    const index = antigravityStepIndex(row.step_index) ?? `line:${line}`;
    for (const message of messages) {
      if (message.category === "calls") {
        message.callId = `agy:${index}:${message.block}`;
        this.pending.push(message.callId);
      }
      if (message.category === "tool") {
        message.callId = this.pending[this.cursor] ?? `agy:tool:${index}`;
        if (this.cursor < this.pending.length) this.cursor++;
        const exact = step?.type === "GENERIC" ? step.times : undefined;
        message.toolTimes = antigravityToolTimes(message.text, exact);
        if (antigravityBackgroundTask(message.text) && commandExitCode(message.text, true) === undefined) {
          const end = exact?.end;
          const start = exact?.start ?? message.toolTimes.start;
          message.toolTimes = { start: end !== undefined && start !== undefined && start > end ? undefined : start, end };
          message.pending = end === undefined;
        }
        if (message.toolTimes.end !== undefined) message.pending = false;
      }
    }
    return messages;
  }
}
