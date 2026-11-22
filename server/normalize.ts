import type { Category } from "../shared/contracts";
import { parseArgs, printable, record, text, type RecordValue } from "./value";

export interface Message {
  category: Category; title: string; text: string; block: number;
  tool?: string; callId?: string; args?: RecordValue; error?: boolean; images?: number; durationMs?: number;
}
export function toolKind(name: string): string {
  const n = name.split(".").at(-1)!.replace(/^mcp__[^_]+__/, "").toLowerCase();
  if (["exec_command", "shell_command", "shell", "bash", "terminal"].includes(n)) return "bash";
  if (["powershell", "pwsh"].includes(n)) return "pwsh";
  return ({ readfile: "read", read_file: "read", read: "read", write: "write", writefile: "write",
    write_file: "write", edit: "edit", edit_file: "edit", multiedit: "edit", grep: "grep",
    glob: "glob", view_image: "read_image", apply_patch: "patch" } as Record<string, string>)[n] ?? n;
}
export function messagesOf(row: RecordValue, provider: string): Message[] {
  const payload = record(row.payload);
  if (provider === "codex") {
    if (row.type === "session_meta") {
      const base = payload.base_instructions;
      const content = typeof base === "string" ? base : text(record(base).text);
      return content ? [{ category: "system", title: "System instructions", text: content, block: -1 }] : [];
    }
    if (row.type === "compacted") {
      if (Array.isArray(payload.replacement_history)) {
        return payload.replacement_history.flatMap((item) => messagesOf({ type: "response_item", payload: item }, "codex"))
          .map((message, block) => ({ ...message, block }));
      }
      return text(payload.message) ? [{ category: "inject", title: "Compaction summary", text: text(payload.message), block: -1 }] : [];
    }
    if (row.type === "turn_context" && Array.isArray(payload.tools)) {
      return payload.tools.map((tool, block) => ({ category: "tools", title: text(record(tool).name), text: printable(tool), block }));
    }
    if (row.type !== "response_item") return [];
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const tool = text(payload.name);
      const args = payload.arguments ?? payload.input;
      return [{ category: "calls", title: tool, text: typeof args === "string" ? args : printable(args),
        tool, callId: text(payload.call_id), args: typeof args === "string" ? (() => { try { return record(JSON.parse(args)); } catch { return { input: args }; } })() : record(args), block: -1 }];
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      return [{ category: "tool", title: "Tool result", text: printable(payload.output),
        callId: text(payload.call_id), block: -1 }];
    }
    if (payload.type === "reasoning") {
      const content = printable(payload.summary ?? payload.content);
      return content ? [{ category: "reasoning", title: "Reasoning", text: content, block: -1 }] : [];
    }
    if (payload.type === "message") {
      const blocks = Array.isArray(payload.content) ? payload.content : [];
      return blocks.map((value, block) => {
        const b = record(value), role = text(payload.role);
        const category: Category = role === "assistant" ? "assistant" : role === "developer" || role === "system" ? "inject" : "user";
        return { category, title: role || "Message", text: printable(b.text ?? b.image_url ?? b),
          block, images: /image/.test(text(b.type)) ? 1 : 0 };
      });
    }
    return [];
  }
  if (provider === "claude") {
    if (row.type === "system" && row.subtype === "compact_boundary") return [];
    const msg = record(row.message);
    if (typeof msg.content === "string") return [{
      category: row.isMeta ? "inject" : row.type === "assistant" ? "assistant" : "user",
      title: text(row.type), text: msg.content, block: -1,
    }];
    if (!Array.isArray(msg.content)) return [];
    return msg.content.map((value, block): Message => {
      const b = record(value), type = text(b.type);
      if (type === "tool_use") return { category: "calls", title: text(b.name), text: printable(b.input),
        tool: text(b.name), callId: text(b.id), args: record(b.input), block };
      if (type === "tool_result") return { category: "tool", title: "Tool result",
        text: printable(b.content), callId: text(b.tool_use_id), error: b.is_error === true, block };
      return { category: type === "thinking" ? "reasoning" : row.type === "assistant" ? "assistant" : row.isMeta ? "inject" : "user",
        title: type === "thinking" ? "Reasoning" : text(row.type), text: printable(b.text ?? b.thinking ?? b),
        images: type === "image" ? 1 : 0, block };
    });
  }
  const type = text(row.type);
  const content = printable(row.text ?? row.message ?? row.content ?? row.detail);
  if (type === "tool_call") {
    const detail = record(row.detail), kind = text(detail.type);
    const args = kind === "shell" ? { command: detail.command, workdir: detail.cwd }
      : kind === "read" ? { file_path: detail.filePath, offset: detail.offset, limit: detail.limit }
      : kind === "edit" ? { file_path: detail.filePath, old_string: detail.oldString, new_string: detail.newString }
      : kind === "write" ? { file_path: detail.filePath, content: detail.content }
      : kind === "search" ? { pattern: detail.query, path: (detail.filePaths as unknown[] | undefined)?.[0] }
      : kind === "fetch" ? { url: detail.url, prompt: detail.prompt }
      : parseArgs(kind === "unknown" ? detail.input ?? row.input : row.input);
    const tool = text(row.name) || ({ shell: "bash", read: "read", edit: "edit", write: "write", search: "grep" } as Record<string, string>)[kind] || kind;
    const callId = text(row.callId ?? row.id);
    const call: Message = { category: "calls", title: tool, text: printable(args), tool, callId, args, block: 0 };
    if (row.status === "running") return [call];
    const captured = kind === "fetch" ? detail.result : kind === "edit" ? detail.unifiedDiff : undefined;
    const result = printable(captured ?? detail.output ?? detail.content ?? detail.text ?? detail.log);
    const exit = typeof detail.exitCode === "number" ? `\nProcess exited with code ${detail.exitCode}` : "";
    const duration = detail.durationMs ?? (typeof detail.durationSeconds === "number" ? detail.durationSeconds * 1000 : undefined);
    const durationMs = typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
    return [call, { category: "tool", title: tool, text: result + exit || printable(row.error) || text(row.status),
      callId, error: row.status === "failed" || row.status === "canceled", durationMs, block: 1 }];
  }
  if (type === "tool_result") return [{ category: "tool", title: "Tool result", text: content, callId: text(row.callId), block: -1 }];
  const category: Category | null = type === "reasoning" ? "reasoning" : /assistant/.test(type) ? "assistant" : /user/.test(type) ? "user" : null;
  return category ? [{ category, title: type, text: content, block: -1 }] : [];
}
