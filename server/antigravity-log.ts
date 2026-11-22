import type { ProviderTiming, Usage } from "../shared/contracts";
import type { Message } from "./normalize";
import { parseArgs, printable, record, text, timestamp, type RecordValue } from "./value";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function antigravityConversationId(handle: string | null): string | null {
  const valid = (id: unknown) => typeof id === "string" && id.length === 36 && UUID.test(id);
  if (!handle) return null;
  if (valid(handle)) return handle.toLowerCase();
  if (!handle.startsWith("plugin:")) return null;
  try {
    const envelope = record(JSON.parse(handle.slice("plugin:".length)));
    const id = record(envelope.data).conversationId;
    return envelope.version === 1 && typeof id === "string" && valid(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
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
      if (body) messages.push({ category: "assistant", title: "Assistant", text: body, block: -1 });
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
  const header = /^Created At:[ \t]*([^\r\n]+)\r?\nCompleted At:[ \t]*([^\r\n]+)/.exec(body);
  if (header) {
    const start = timestamp(header[1]), end = timestamp(header[2]);
    if (start > 0 && end >= start) return { start, end };
  }
  if (exact?.start !== undefined && exact.end !== undefined && exact.end < exact.start) return { start: exact.start };
  return exact ?? {};
}

export class AntigravityCalls {
  private pending: string[] = [];
  private cursor = 0;
  private lastPlannerId = "";

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
        if (exact?.end !== undefined) message.pending = false;
      }
    }
    return messages;
  }
}
