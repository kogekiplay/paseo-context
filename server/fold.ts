import { emptyParts, emptyUsage, type Agent, type Command, type ContextEvent, type ContextNode, type FileActivity, type Parts, type Request, type Summary, type Tally, type Usage } from "../shared/contracts";
import { estimateTextTokens } from "../shared/core/estimate";
import { programsOfCommand } from "../shared/core/commands";
import { opsOfCall, IMAGE_FILE_EXT } from "../shared/core/fileOps";
import { SessionFold } from "./meter";
import { CollaborationLedger } from "./collaboration";
import { messagesOf, toolKind, type Message } from "./normalize";
import { count, parseArgs, printable, record, text, timestamp, type RecordValue } from "./value";
import { unionMs } from "./timing";

export class ContextFold {
  readonly nodes: ContextNode[] = [];
  readonly requests: Request[] = [];
  readonly events: ContextEvent[] = [];
  readonly files: FileActivity[] = [];
  readonly commands: Command[] = [];
  readonly tools = new Map<string, Tally>();
  readonly skills = new Map<string, Tally>();
  readonly programs = new Map<string, Tally>();
  readonly toolEpochs: Array<{ seq: number; time: number; nodeIds: number[] }> = [];
  readonly meter: SessionFold;
  readonly collaboration = new CollaborationLedger();
  contextTokens: number | null = null;
  contextWindow: number | null = null;
  maxOutput: number | null = null;
  model = "";
  humanInputs = 0;
  images = 0;
  private line = 0;
  private turn = 0;
  private active = emptyParts();
  private pending: { boundary: number; seq: number; parts: Parts; start: number } | null = null;
  private calls = new Map<string, { node: ContextNode; command?: Command; files: FileActivity[]; skill?: string }>();
  private requestIds = new Map<string, number>();
  private claudeNodes = new Map<string, Map<string, number>>();
  private turnIds = new Set<string>();
  private boundaryAt = 0;
  private nodeTurns: number[] = [];
  private background = new Map<string, Command>();
  private lastPrompt = "";
  private modelMs = 0;
  private toolMs = 0;
  private slot = 2;
  private toolIntervals = new Map<string, { start: number; end: number; kind: "tools" }>();
  get revision() { return this.line; }

  constructor(readonly provider: string) {
    this.meter = new SessionFold(provider === "claude" ? "claude" : "codex");
  }
  private tally(map: Map<string, Tally>, name: string, at: number) {
    if (!name) return;
    const t = map.get(name) ?? { name, count: 0, last: 0 };
    t.count++;
    t.last = Math.max(t.last, at);
    map.set(name, t);
  }
  private event(kind: ContextEvent["kind"], at: number, title: string, detail: string) {
    this.events.push({ id: this.events.length, seq: this.line * 1_000_000, time: at, kind, title, detail });
  }
  private compact(at: number) {
    for (const n of this.nodes) if (n.gone === undefined && n.category !== "system" && n.category !== "tools") {
      n.gone = this.nodes.length; n.goneSeq = this.line * 1_000_000;
    }
    const keep = { system: this.active.system, tools: this.active.tools };
    this.active = { ...emptyParts(), ...keep };
    this.contextTokens = null;
    this.pending = null;
    this.event("compaction", at, "Context compacted", "Earlier messages were replaced by a summary.");
  }
  private add(message: Message, at: number, row: RecordValue) {
    if (!message.text && !message.tool && !message.images) return;
    if (this.provider === "claude") {
      const key = text(record(row.message).id) || text(row.uuid);
      if (key) {
        const seen = this.claudeNodes.get(key) ?? new Map<string, number>();
        const signature = `${row.apiBlockIndex ?? message.block}:${message.category}:${message.callId ?? ""}`;
        const previous = seen.get(signature);
        if (previous !== undefined) {
          const node = this.nodes[previous], tokens = estimateTextTokens(message.text);
          if (node.gone === undefined) this.active[node.category] += tokens - node.tokens;
          node.tokens = tokens; node.preview = message.text.replace(/\s+/g, " ").slice(0, 180);
          node.line = this.line; node.block = message.block;
          return;
        }
        seen.set(signature, this.nodes.length);
        this.claudeNodes.set(key, seen);
      }
    }
    if (message.category === "user") {
      this.lastPrompt = message.text.replace(/\s+/g, " ").slice(0, 180);
    }
    if (["assistant", "reasoning", "calls"].includes(message.category) && this.pending === null) {
      this.pending = { boundary: this.nodes.length, seq: this.line * 1_000_000 + 1, parts: { ...this.active }, start: this.boundaryAt || at };
    }
    const tokens = message.images ? 1024 * message.images : estimateTextTokens(message.text);
    const node: ContextNode = {
      id: this.nodes.length, seq: this.line * 1_000_000 + this.slot++, line: this.line, block: message.block, category: message.category, time: at,
      tokens, title: message.title || message.category, preview: message.text.replace(/\s+/g, " ").slice(0, 180),
      ...(message.images ? { images: message.images } : {}),
      ...(message.callId ? { callId: message.callId } : {}), ...(message.tool ? { tool: message.tool, source: this.toolSource(message.tool) } : {}),
    };
    let loadedSkill: string | undefined;
    if (message.category === "tool" && message.callId) {
      const call = this.calls.get(message.callId);
      if (call) {
        loadedSkill = call.skill;
        node.tool = call.node.tool;
        node.title = call.node.title;
        node.source = call.node.source;
        this.toolMs += Math.max(0, at - call.node.time);
        this.toolIntervals.set(message.callId, { start: call.node.time, end: at, kind: "tools" });
        for (const file of call.files) file.error = message.error === true;
        if (call.command) {
          const c = call.command;
          const code = /(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?[=: ]+|Process exited with code )(-?\d+)/i.exec(message.text);
          const background = /Process running with session ID|still running|background job/i.test(message.text);
          c.exit = code ? Number(code[1]) : null;
          c.status = background ? "running" : message.error || (c.exit !== null && c.exit !== 0) ? "failed" : "completed";
          c.duration = background ? null : Math.max(0, at - c.time);
          c.outputNode = node.id;
          c.outputNodes ??= [];
          if (!c.outputNodes.includes(node.id)) c.outputNodes.push(node.id);
          const processId = /Process running with session ID\s+([a-zA-Z0-9_-]+)/.exec(message.text)?.[1];
          if (processId) this.background.set(processId, c);
          if (!background) for (const [id, command] of this.background) if (command === c) this.background.delete(id);
        }
      }
    }
    this.images += message.images ?? 0;
    this.nodes.push(node);
    this.nodeTurns.push(this.turn);
    this.active[message.category] += tokens;
    this.collaboration.apply(message, node.id, at);
    if (message.category === "calls" && message.tool) this.call(node, message, at);
    if (message.category === "inject") this.event("inject", at, message.title, node.preview);
    if (message.category === "tool" && loadedSkill) {
      const name = /(?:^|\n)name:\s*([^\n]+)/.exec(message.text)?.[1]?.trim() ?? loadedSkill;
      node.category = "skill";
      this.active.tool -= tokens;
      this.active.skill += tokens;
      this.tally(this.skills, name, at);
      this.event("skill", at, name, node.preview);
    }
  }
  private toolSource(name: string) {
    const named = /^mcp__(.+?)__/.exec(name);
    if (named) return `mcp:${named[1]}`;
    const m = /^(?:mcp__|mcp[._])([^_.]+)(?:__|[._])/.exec(name);
    return m ? `mcp:${m[1]}` : name.includes(".") ? name.split(".").slice(0, -1).join(".") : "provider";
  }
  private call(node: ContextNode, message: Message, at: number) {
    const name = message.tool!, kind = toolKind(name), args = message.args ?? parseArgs(message.text);
    this.tally(this.tools, name, at);
    const files: FileActivity[] = opsOfCall({ seq: node.id, tool: kind, argsRaw: JSON.stringify(args), time: at }).map((f) => ({
      id: node.id, time: at, path: f.path, kind: IMAGE_FILE_EXT.test(f.path) ? "image" : f.kind,
      tool: name, added: f.added, removed: f.removed, error: false,
    }));
    if (kind === "patch") {
      const patch = text(args.input) || message.text;
      for (const match of patch.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n]+)/g)) {
        files.push({ id: node.id, time: at, path: match[1], kind: "write", tool: name,
          added: (patch.match(/^\+[^+]/gm) ?? []).length, removed: (patch.match(/^-[^-]/gm) ?? []).length, error: false });
      }
    }
    this.files.push(...files);
    let command: Command | undefined;
    if (kind === "bash" || kind === "pwsh") {
      const cmd = text(args.cmd ?? args.command);
      if (cmd) {
        const programs = programsOfCommand(cmd, kind);
        for (const program of programs) this.tally(this.programs, program, at);
        command = { id: node.id, time: at, tool: name, command: cmd.slice(0, 2000), cwd: text(args.workdir ?? args.cwd),
          programs, status: "running", exit: null, duration: null, outputNode: null };
        this.commands.push(command);
      }
    }
    if (kind === "write_stdin") command = this.background.get(String(args.session_id ?? ""));
    const skillPath = files.find((f) => /(?:^|[/\\])SKILL\.md$/i.test(f.path))?.path
      ?? (command && /\b(?:cat|sed|head|bat)\b/.test(command.command) ? command.command.match(/(?:^|\s)([^\s'"]*SKILL\.md)\b/)?.[1] : undefined);
    const skill = skillPath ? skillPath.replace(/[/\\]SKILL\.md$/i, "").split(/[/\\]/).at(-1) : /(?:^|[._])skill$/i.test(name) ? text(args.name) || "skill" : undefined;
    if (message.callId) this.calls.set(message.callId, { node, command, files, skill });
  }
  private request(id: string, usage: Usage, at: number, model: string) {
    const previousIndex = this.requestIds.get(id);
    if (previousIndex !== undefined) {
      const previous = this.requests[previousIndex];
      previous.usage = usage;
      if (this.provider === "claude") {
        previous.response = this.nodes.slice(previous.boundary).filter((n) => ["assistant", "calls"].includes(n.category)).map((n) => n.preview).join(" · ").slice(0, 240);
        previous.duration = at > previous.time ? at - previous.time : null;
        this.pending = null;
      }
      return;
    }
    const pending = this.pending ?? { boundary: this.nodes.length, seq: this.line * 1_000_000 + 1, parts: { ...this.active }, start: at };
    const response = this.nodes.slice(pending.boundary).filter((n) => ["assistant", "calls"].includes(n.category)).map((n) => n.preview).join(" · ").slice(0, 240);
    const duration = at > pending.start ? at - pending.start : null;
    this.requests.push({ id, index: this.requests.length + 1, turn: Math.max(1, this.turn), time: pending.start || at,
      boundary: pending.boundary, seq: pending.seq, parts: pending.parts, usage, model: model || this.model,
      duration, prompt: this.lastPrompt, response, costUsd: null });
    this.requestIds.set(id, this.requests.length - 1);
    this.contextTokens = usage.input || this.contextTokens;
    this.pending = null;
  }
  apply(value: unknown) {
    this.line++;
    this.slot = 2;
    const row = record(value), p = record(row.payload), at = timestamp(row.timestamp ?? row.createdAt);
    if (this.provider === "claude" && (row.isSidechain === true || row.isApiErrorMessage === true)) return;
    const before = { ...this.meter.stats };
    if (this.provider === "codex" || this.provider === "claude") this.meter.apply(row);
    if (row.type === "turn_context") {
      const turnId = text(p.turn_id) || `context:${this.line}`;
      this.turnIds.add(turnId); this.turn = this.turnIds.size;
      const model = text(p.model);
      if (model && model !== this.model) {
        if (this.model) this.event("model", at, model, `${this.model} → ${model}`);
        this.model = model;
      }
      if (p.effort) this.event("mode", at, text(p.effort), "Reasoning effort");
    }
    if (row.type === "event_msg" && p.type === "task_started" && text(p.turn_id)) {
      this.turnIds.add(text(p.turn_id)); this.turn = this.turnIds.size;
    }
    if (row.type === "event_msg" && p.type === "thread_rolled_back") {
      const n = Math.floor(count(p.num_turns));
      const turns = [...new Set(this.nodes.filter((node) => node.category === "user" && node.gone === undefined).map((node) => this.nodeTurns[node.id]))];
      const removed = new Set(turns.slice(Math.max(0, turns.length - n)));
      if (n > 0) {
        for (const node of this.nodes) if (node.gone === undefined && removed.has(this.nodeTurns[node.id]) && node.category !== "system" && node.category !== "tools") {
          node.gone = this.nodes.length; node.goneSeq = this.line * 1_000_000;
        }
        this.active = emptyParts();
        for (const node of this.nodes) if (node.gone === undefined) this.active[node.category] += node.tokens;
        this.pending = null; this.contextTokens = null;
        this.event("prune", at, "Conversation rollback", `${n} turns removed from active context`);
      }
    }
    if (row.type === "compacted" || (row.type === "system" && row.subtype === "compact_boundary")
      || (row.type === "compaction" && row.status === "completed")) this.compact(at);
    const info = record(p.info);
    if (count(info.model_context_window) > 0) this.contextWindow = count(info.model_context_window);
    if (count(p.model_context_window) > 0) this.contextWindow = count(p.model_context_window);
    const messages = messagesOf(row, this.provider);
    if (messages.some((m) => m.category === "user")) {
      this.humanInputs++;
      if (this.provider !== "codex") this.turn++;
    }
    if (this.provider === "claude" && row.type === "assistant" && text(record(row.message).id)) {
      const previous = this.requestIds.get(text(record(row.message).id));
      const request = previous === undefined ? null : this.requests[previous];
      this.pending = request ? { boundary: request.boundary, seq: request.seq!, parts: request.parts, start: request.time }
        : { boundary: this.nodes.length, seq: this.line * 1_000_000 + 1, parts: { ...this.active }, start: this.boundaryAt || at };
    }
    if (row.type === "turn_context" && Array.isArray(p.tools)) {
      for (const node of this.nodes) if (node.category === "tools" && node.gone === undefined) {
        node.gone = this.nodes.length; node.goneSeq = this.line * 1_000_000;
      }
      this.active.tools = 0;
    }
    const firstNode = this.nodes.length;
    for (const message of messages) this.add(message, at, row);
    if (row.type === "turn_context" && Array.isArray(p.tools)) this.toolEpochs.push({
      seq: this.line * 1_000_000 + 1, time: at,
      nodeIds: this.nodes.slice(firstNode).filter((node) => node.category === "tools").map((node) => node.id),
    });
    if (messages.some((message) => message.category === "user" || message.category === "tool")) this.boundaryAt = at;
    const stats = this.meter.stats;
    this.modelMs = stats.modelMs;
    if (this.provider === "claude" && row.type === "assistant" && record(row.message).usage) {
      const msg = record(row.message), raw = record(msg.usage), model = text(msg.model);
      if (model) this.model = model;
      this.request(text(msg.id) || String(this.line), {
        input: count(raw.input_tokens) + count(raw.cache_read_input_tokens) + count(raw.cache_creation_input_tokens),
        cacheRead: count(raw.cache_read_input_tokens), cacheWrite: count(raw.cache_creation_input_tokens),
        output: count(raw.output_tokens), reasoning: count(raw.reasoning_tokens),
      }, at, model);
    } else if (row.type === "token_usage_record") {
      const u = record(p.usage);
      this.request(text(p.response_id) || String(row.ordinal ?? row.timestamp), {
        input: count(u.input_tokens), cacheRead: count(u.cached_input_tokens), cacheWrite: count(u.cache_write_input_tokens),
        output: count(u.output_tokens), reasoning: count(u.reasoning_output_tokens),
      }, at, text(p.model));
    } else if (row.type === "event_msg" && p.type === "token_count" && stats.steps > before.steps) {
      this.request(`legacy:${this.line}`, {
        input: Math.max(0, stats.inputTokens - before.inputTokens), cacheRead: Math.max(0, stats.cachedTokens - before.cachedTokens),
        cacheWrite: Math.max(0, stats.cacheWriteTokens - before.cacheWriteTokens), output: Math.max(0, stats.outputTokens - before.outputTokens),
        reasoning: count(record(info.last_token_usage).reasoning_output_tokens),
      }, at, this.model);
    }
  }
  summary(agent: Agent, source: Summary["source"] = "native"): Summary {
    const s = this.meter.stats, usage = emptyUsage();
    usage.input = s.inputTokens; usage.output = s.outputTokens; usage.cacheRead = s.cachedTokens; usage.cacheWrite = s.cacheWriteTokens;
    usage.reasoning = this.requests.reduce((n, r) => n + r.usage.reasoning, 0);
    const sorted = (map: Map<string, Tally>) => [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const intervals: NonNullable<Summary["intervals"]> = [...this.toolIntervals.values(),
      ...this.requests.filter((r) => r.duration !== null).map((r) => ({ start: r.time, end: r.time + r.duration!, kind: "model" as const }))];
    return { agent: { ...agent, model: this.model || agent.model }, source, usage,
      turns: s.turns || this.turn || this.humanInputs, steps: s.steps || this.requests.length, humanInputs: this.humanInputs,
      toolCalls: [...this.tools.values()].reduce((n, t) => n + t.count, 0), images: this.images,
      contextTokens: this.contextTokens, contextWindow: this.contextWindow, maxOutput: this.maxOutput,
      parts: { ...this.active }, costUsd: null, costComplete: false,
      modelMs: this.modelMs, toolMs: [...this.toolIntervals.values()].reduce((n, row) => n + Math.max(0, row.end - row.start), 0),
      ttftMs: s.ttftMs, timedOutputTokens: s.timedOutputTokens, intervals, wallMs: unionMs(intervals),
      tools: sorted(this.tools), skills: sorted(this.skills), programs: sorted(this.programs), activity: this.activity(),
      notices: [source === "native" ? "native-estimate" : source === "timeline" ? "timeline-limited" : "unavailable",
        ...(!this.nodes.some((n) => n.category === "system") ? ["system-unavailable"] : []),
        ...(!this.nodes.some((n) => n.category === "tools") ? ["schemas-unavailable"] : [])],
    };
  }
  private activity(): Summary["activity"] {
    const days = new Map<number, { time: number; tools: Map<string, Tally>; skills: Map<string, Tally>; programs: Map<string, Tally> }>();
    const add = (kind: "tools" | "skills" | "programs", name: string, at: number) => {
      const date = new Date(at); date.setHours(0, 0, 0, 0); const time = date.getTime();
      const day = days.get(time) ?? { time, tools: new Map(), skills: new Map(), programs: new Map() };
      this.tally(day[kind], name, at); days.set(time, day);
    };
    for (const node of this.nodes) if (node.category === "calls" && node.tool) add("tools", node.tool, node.time);
    for (const event of this.events) if (event.kind === "skill") add("skills", event.title, event.time);
    for (const command of this.commands) for (const program of command.programs) add("programs", program, command.time);
    return [...days.values()].map((day) => ({ time: day.time, tools: [...day.tools.values()], skills: [...day.skills.values()], programs: [...day.programs.values()] }));
  }
  private activeWallMs() {
    const intervals = this.nodes.map((n) => n.time).filter((n) => n > 0).sort((a, b) => a - b);
    let total = 0;
    for (let i = 1; i < intervals.length; i++) {
      const gap = intervals[i] - intervals[i - 1];
      if (gap < 300_000) total += gap;
    }
    return total;
  }
}
