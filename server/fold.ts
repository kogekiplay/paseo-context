import { emptyParts, type Agent, type Command, type ContextEvent, type ContextNode, type FileActivity, type Parts, type Request, type Summary, type Tally } from "../shared/contracts";
import { estimateTextTokens } from "../shared/core/estimate";
import { programsOfCommand } from "../shared/core/commands";
import { opsOfCall, opBearingTool, patchFiles, IMAGE_FILE_EXT } from "../shared/core/fileOps";
import { SessionFold, type UsageObservation } from "./meter";
import { CollaborationLedger } from "./collaboration";
import { messagesOf, toolKind, type Message } from "./normalize";
import { AntigravityCalls, antigravityMessages, type AntigravityStep } from "./antigravity-log";
import { count, parseArgs, record, text, timestamp, type RecordValue } from "./value";
import { unionMs } from "./timing";
import { usageKeys } from "./usage-fields";
import { StatisticsSpans } from "./statistics-spans";
import { createHash, randomUUID } from "node:crypto";

interface PendingRequest { boundary: number; seq: number; parts: Parts; start: number; anchor: number }
type RequestTiming = Partial<Pick<Request,
  "estimatedModelMs" | "estimatedTtftMs" | "estimatedModelStart" | "estimatedModelEnd" | "providerTiming">>;
const nodeHash = (value: string) => createHash("sha256").update(value).digest("hex");

export class ContextFold {
  readonly nodes: ContextNode[] = [];
  readonly contentHashes: string[] = [];
  readonly toolResults = new Map<string, ContextNode>();
  readonly requests: Request[] = [];
  readonly events: Array<ContextEvent & { seq: number }> = [];
  readonly files: FileActivity[] = [];
  readonly commands: Command[] = [];
  readonly tools = new Map<string, Tally>();
  readonly skills = new Map<string, Tally>();
  readonly programs = new Map<string, Tally>();
  readonly toolEpochs: Array<{ seq: number; time: number; nodeIds: number[] }> = [];
  readonly meter: SessionFold;
  readonly collaboration = new CollaborationLedger();
  readonly statistics = new StatisticsSpans();
  contextTokens: number | null = null;
  contextWindow: number | null = null;
  maxOutput: number | null = null;
  model = "";
  humanInputs = 0;
  images = 0;
  private line = 0;
  private turn = 0;
  private active = emptyParts();
  private pending: PendingRequest | null = null;
  private calls = new Map<string, { node: ContextNode; command?: Command; files: FileActivity[]; skill?: string }>();
  private toolCallCount = 0;
  private antigravityCalls?: AntigravityCalls;
  private requestIds = new Map<string, number>();
  private claudeNodes = new Map<string, Map<string, number>>();
  private turnIds = new Set<string>();
  private boundaryAt = 0;
  private boundaryLine = 0;
  private lastAnchor = 0;
  private contextRequest = -1;
  private contextFloor = 0;
  private nodeTurns: number[] = [];
  private background = new Map<string, Command>();
  private lastPrompt = "";
  private modelMs = 0;
  private slot = 2;
  private toolIntervals = new Map<string, { start: number; end: number; kind: "tools" }>();
  private toolDurations = new Map<string, number>();
  get revision() { return this.line; }
  get hasToolTiming() { return this.toolDurations.size > 0; }
  requestIndex(id: string) { return this.requestIds.get(id); }
  get residentBytes() {
    return this.line * 160 + this.nodes.length * 768 + this.requests.length * 768
      + this.events.length * 256 + this.files.length * 384 + this.commands.length * 4608 + this.collaboration.residentBytes;
  }

  constructor(readonly provider: string, readonly epoch: string = randomUUID()) {
    this.meter = new SessionFold(provider === "claude" || provider === "antigravity" ? provider : "codex");
    if (provider === "antigravity") this.antigravityCalls = new AntigravityCalls();
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
  private observeModel(model: string, at: number) {
    if (!model || model === this.model) return;
    if (this.model) this.event("model", at, model, `${this.model} → ${model}`);
    this.model = model;
  }
  private compact(at: number) {
    for (const n of this.nodes) if (n.gone === undefined && n.category !== "system" && n.category !== "tools") {
      n.gone = this.nodes.length; n.goneSeq = this.line * 1_000_000;
    }
    const keep = { system: this.active.system, tools: this.active.tools };
    this.active = { ...emptyParts(), ...keep };
    this.resetContext();
    this.event("compaction", at, "Context compacted", "Earlier messages were replaced by a summary.");
  }
  private resetContext() {
    this.contextTokens = null;
    this.contextFloor = this.requests.length;
    this.pending = null;
    this.lastAnchor = this.boundaryLine;
  }
  private startRequest(at: number): PendingRequest {
    const anchor = this.boundaryLine > this.lastAnchor ? this.boundaryLine : 0;
    return { boundary: this.nodes.length, seq: this.line * 1_000_000 + 1, parts: { ...this.active },
      start: anchor && this.boundaryAt > 0 ? this.boundaryAt : at, anchor };
  }
  private add(message: Message, at: number, row: RecordValue, replayed: boolean, metadataOnly: boolean) {
    if (!message.text && !message.tool && !message.images && !(this.antigravityCalls && message.callId)) return;
    if (!replayed && this.provider === "timeline" && message.category === "calls"
      && message.callId && this.calls.has(message.callId)) return;
    if (this.provider === "claude") {
      const key = text(record(row.message).id) || text(row.uuid);
      if (key) {
        const seen = this.claudeNodes.get(key) ?? new Map<string, number>();
        const signature = `${row.apiBlockIndex ?? message.block}:${message.category}:${message.callId ?? ""}`;
        const previous = seen.get(signature);
        if (previous !== undefined) {
          const node = this.nodes[previous], tokens = message.images ? 1024 * message.images : estimateTextTokens(message.text);
          if (node.gone === undefined) this.active[node.category] += tokens - node.tokens;
          node.tokens = tokens; node.preview = message.text.replace(/\s+/g, " ").slice(0, 180);
          node.textLength = message.text.length;
          node.line = this.line; node.block = message.block;
          node.error = message.error;
          this.contentHashes[previous] = nodeHash(message.text);
          return;
        }
        seen.set(signature, this.nodes.length);
        this.claudeNodes.set(key, seen);
      }
    }
    if (!replayed && message.category === "user") {
      this.lastPrompt = message.text.replace(/\s+/g, " ").slice(0, 180);
    }
    if (!replayed && ["assistant", "reasoning", "calls"].includes(message.category) && this.pending === null) {
      this.pending = this.startRequest(at);
    }
    const tokens = metadataOnly ? 0 : message.images ? 1024 * message.images : estimateTextTokens(message.text);
    const node: ContextNode = {
      id: this.nodes.length, seq: this.line * 1_000_000 + this.slot++, line: this.line, block: message.block, category: message.category, time: at,
      tokens, title: message.title || message.category, preview: message.text.replace(/\s+/g, " ").slice(0, 180),
      textLength: message.text.length,
      ...(message.images ? { images: message.images } : {}),
      ...(message.callId ? { callId: message.callId } : {}), ...(message.tool ? { tool: message.tool, source: this.toolSource(message.tool) } : {}),
      ...(message.error === undefined ? {} : { error: message.error }), ...(replayed ? { replayed: true } : {}),
    };
    let loadedSkill: string | undefined;
    if (message.category === "tool" && message.callId) {
      const call = this.calls.get(message.callId);
      const start = message.toolTimes?.start, end = message.toolTimes?.end;
      const explicit = start !== undefined && end !== undefined && end >= start;
      const paired = !this.antigravityCalls && call && call.node.time > 0 && at >= call.node.time
        && (this.provider !== "timeline" || call.node.line !== this.line);
      const duration = message.durationMs ?? (explicit ? end - start : paired ? at - call.node.time : undefined);
      if (start !== undefined) node.toolStartedAt = start;
      if (end !== undefined && (start === undefined || end >= start)) node.toolEndedAt = end;
      if (!replayed && !message.pending && duration !== undefined) {
        node.toolDurationMs = duration;
        this.toolDurations.set(message.callId, duration);
        if (explicit) this.toolIntervals.set(message.callId, { start, end, kind: "tools" });
        else if (paired) this.toolIntervals.set(message.callId, { start: call.node.time, end: at, kind: "tools" });
      }
      if (call) {
        loadedSkill = call.skill;
        node.tool = call.node.tool;
        node.title = call.node.title;
        node.source = call.node.source;
        if (!replayed && start !== undefined) {
          call.node.toolStartedAt = start;
          call.node.time = start;
          if (call.command) call.command.time = start;
          for (const file of call.files) file.time = start;
          const tally = call.node.tool && this.tools.get(call.node.tool);
          if (tally) tally.last = Math.max(tally.last, start);
          for (const program of call.command?.programs ?? []) {
            const tally = this.programs.get(program)!;
            tally.last = Math.max(tally.last, start);
          }
        }
        if (!replayed && !message.pending) for (const file of call.files) file.error = message.error === true;
        if (!replayed && !message.pending && call.command) {
          const c = call.command;
          const code = /(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?[=: ]+|Process exited with code )(-?\d+)/i.exec(message.text);
          const background = /Process running with session ID|still running|background job/i.test(message.text);
          c.exit = code ? Number(code[1]) : null;
          c.status = background ? "running" : message.error || (c.exit !== null && c.exit !== 0) ? "failed" : "completed";
          c.duration = background ? null : duration
            ?? (!this.antigravityCalls && c.time > 0 && at >= c.time && (this.provider !== "timeline" || paired) ? at - c.time : null);
          c.outputNode = node.id;
          c.outputNodes ??= [];
          if (!c.outputNodes.includes(node.id)) c.outputNodes.push(node.id);
          const processId = /Process running with session ID\s+([a-zA-Z0-9_-]+)/.exec(message.text)?.[1];
          if (processId) this.background.set(processId, c);
          if (!background) for (const [id, command] of this.background) if (command === c) this.background.delete(id);
        }
      }
    }
    this.nodes.push(node);
    this.contentHashes[node.id] = nodeHash(message.text);
    this.nodeTurns.push(this.turn);
    this.active[message.category] += tokens;
    if (!replayed) {
      this.images += message.images ?? 0;
      this.collaboration.apply(message, node.id, at);
      if (message.category === "tool" && message.callId && !message.pending) this.toolResults.set(message.callId, node);
      if (message.category === "calls" && (message.tool || this.antigravityCalls && message.callId)) this.call(node, message, at);
      if (message.category === "inject") this.event("inject", at, message.title, node.preview);
    }
    if (message.category === "tool" && loadedSkill) {
      const name = /(?:^|\n)name:\s*([^\n]+)/.exec(message.text)?.[1]?.trim() ?? loadedSkill;
      node.category = "skill";
      this.active.tool -= tokens;
      this.active.skill += tokens;
      if (!replayed && !message.pending) {
        this.tally(this.skills, name, at);
        this.event("skill", at, name, node.preview);
      }
    }
  }
  private toolSource(name: string) {
    const named = /^mcp__(.+?)__/.exec(name);
    if (named) return `mcp:${named[1]}`;
    const m = /^(?:mcp__|mcp[._])([^_.]+)(?:__|[._])/.exec(name);
    return m ? `mcp:${m[1]}` : name.includes(".") ? name.split(".").slice(0, -1).join(".") : "provider";
  }
  private call(node: ContextNode, message: Message, at: number) {
    const name = message.tool || "", kind = toolKind(name), args = message.args ?? parseArgs(message.text);
    this.toolCallCount++;
    this.tally(this.tools, name, at);
    const files: FileActivity[] = opsOfCall({ seq: node.id, tool: kind, argsRaw: opBearingTool(kind) ? JSON.stringify(args) : undefined, time: at }).map((f) => ({
      id: node.id, time: at, path: f.path, kind: IMAGE_FILE_EXT.test(f.path) ? "image" : f.kind,
      tool: name, added: f.added, removed: f.removed, error: false,
    }));
    if (kind === "patch") {
      const patch = text(args.input) || message.text;
      for (const file of patchFiles(patch)) files.push({ ...file, id: node.id, time: at, kind: "write", tool: name, error: false });
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
  private request(observation: UsageObservation, at: number, model: string, timing: RequestTiming,
    native?: { start: number; checkpoint: boolean }) {
    const { id, usage, sources } = observation;
    const fields = usageKeys.filter((field) => sources[field] !== undefined);
    const previousIndex = this.requestIds.get(id);
    const index = previousIndex ?? this.requests.length;
    if (!native?.checkpoint && sources.input === "reported" && index >= this.contextFloor && index >= this.contextRequest) {
      this.contextTokens = usage.input;
      this.contextRequest = index;
    }
    if (previousIndex !== undefined) {
      const previous = this.requests[previousIndex];
      previous.usage = usage;
      previous.usageFields = fields;
      previous.usageSources = sources;
      if (model) previous.model = model;
      if (!previous.usageAt && at > 0) previous.usageAt = at;
      Object.assign(previous, timing);
      if (this.provider === "claude") {
        previous.response = this.nodes.slice(previous.boundary).filter((n) => ["assistant", "calls"].includes(n.category)).map((n) => n.preview).join(" · ").slice(0, 240);
        previous.duration = at > previous.time ? at - previous.time : null;
        this.pending = null;
      }
      if (native) {
        if (at > 0) previous.usageAt = at;
        previous.response = this.nodes.slice(previous.boundary).filter((n) => ["assistant", "calls"].includes(n.category)).map((n) => n.preview).join(" · ").slice(0, 240);
        previous.duration = timing.providerTiming?.modelMs ?? previous.duration;
        this.pending = null;
      }
      return;
    }
    const pending = this.pending ?? this.startRequest(at);
    const response = this.nodes.slice(pending.boundary).filter((n) => ["assistant", "calls"].includes(n.category)).map((n) => n.preview).join(" · ").slice(0, 240);
    const start = native ? native.start || at : pending.start || at;
    const duration = native ? timing.providerTiming?.modelMs ?? (at > start && start > 0 ? at - start : null)
      : at > pending.start ? at - pending.start : null;
    this.requests.push({ id, index: this.requests.length + 1, turn: Math.max(1, this.turn), time: start,
      boundary: pending.boundary, seq: pending.seq, parts: pending.parts, usage, model: model || (native?.checkpoint ? "" : this.model),
      duration, prompt: this.lastPrompt, response, costUsd: null, usageFields: fields, usageSources: sources,
      ...(at > 0 ? { usageAt: at } : {}), ...timing });
    this.requestIds.set(id, this.requests.length - 1);
    this.lastAnchor = Math.max(this.lastAnchor, pending.anchor);
    this.pending = null;
  }
  apply(value: unknown, native?: AntigravityStep, metadataOnly = false) {
    this.line++;
    this.slot = 2;
    const row = record(value), p = record(row.payload);
    const antigravity = this.antigravityCalls;
    const at = native?.at ?? timestamp(row.timestamp ?? row.createdAt ?? row.created_at);
    if (this.provider === "claude" && (row.isSidechain === true || row.isApiErrorMessage === true)) return;
    if (this.provider === "codex" || this.provider === "claude" || antigravity) this.meter.apply(row, this.line, native);
    if (row.type === "turn_context") {
      const turnId = text(p.turn_id) || `context:${this.line}`;
      this.turnIds.add(turnId); this.turn = this.turnIds.size;
      this.observeModel(text(p.model), at);
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
        this.resetContext();
        this.event("prune", at, "Conversation rollback", `${n} turns removed from active context`);
      }
    }
    const checkpoint = !!antigravity && row.type === "CHECKPOINT";
    const checkpointRequest = checkpoint && this.meter.lastUsage ? this.startRequest(at) : null;
    if (checkpointRequest) checkpointRequest.seq = this.line * 1_000_000 - 1;
    const agyUsageAt = native?.type === "PLANNER_RESPONSE" || native?.type === "CHECKPOINT" ? native.usageAt : undefined;
    if (row.type === "compacted" || (row.type === "system" && row.subtype === "compact_boundary")
      || (row.type === "compaction" && row.status === "completed") || checkpoint) this.compact(checkpoint ? agyUsageAt ?? at : at);
    const info = record(p.info);
    if (count(info.model_context_window) > 0) this.contextWindow = count(info.model_context_window);
    if (count(p.model_context_window) > 0) this.contextWindow = count(p.model_context_window);
    const providerTiming = this.meter.lastProviderTiming;
    const messages = antigravity ? antigravity.link(row, antigravityMessages(row, metadataOnly), this.line, native)
      : messagesOf(row, this.provider);
    const replayed = row.type === "compacted" && Array.isArray(p.replacement_history);
    const hasUser = !replayed && messages.some((message) => message.category === "user");
    if (hasUser) {
      this.humanInputs++;
      if (this.provider !== "codex") this.turn++;
      if (antigravity) this.lastPrompt = "";
    }
    if (this.provider === "claude" && row.type === "assistant" && text(record(row.message).id)) {
      const previous = this.requestIds.get(text(record(row.message).id));
      const request = previous === undefined ? null : this.requests[previous];
      this.pending = request ? { boundary: request.boundary, seq: request.seq!, parts: request.parts, start: request.time, anchor: 0 }
        : this.pending ?? this.startRequest(at);
    }
    if (row.type === "turn_context" && Array.isArray(p.tools)) {
      for (const id of this.toolEpochs.at(-1)?.nodeIds ?? []) {
        const node = this.nodes[id];
        node.gone = this.nodes.length; node.goneSeq = this.line * 1_000_000;
      }
      this.active.tools = 0;
    }
    const firstNode = this.nodes.length;
    for (const message of messages) {
      const time = message.toolTimes?.end ?? providerTiming?.end ?? (checkpoint ? agyUsageAt : undefined) ?? at;
      this.add(message, time, row, replayed, metadataOnly);
    }
    if (row.type === "turn_context" && Array.isArray(p.tools)) this.toolEpochs.push({
      seq: this.line * 1_000_000 + 1, time: at,
      nodeIds: this.nodes.slice(firstNode).filter((node) => node.category === "tools").map((node) => node.id),
    });
    if (hasUser || !replayed && this.provider !== "timeline" && messages.some((message) => message.category === "tool")) {
      this.boundaryAt = at;
      this.boundaryLine = this.line;
    }
    const stats = this.meter.stats;
    this.modelMs = stats.modelMs;
    const measured = this.meter.lastTiming;
    const timing: RequestTiming = providerTiming ? { providerTiming } : measured ? { estimatedModelMs: measured.modelMs, estimatedModelStart: measured.start,
      estimatedModelEnd: measured.end, ...(measured.ttftMs === undefined ? {} : { estimatedTtftMs: measured.ttftMs }) } : {};
    const observation = this.meter.lastUsage;
    const agyModel = antigravity ? text(row.model) : "";
    if (agyModel) this.observeModel(agyModel, at);
    if (observation) {
      const model = antigravity ? agyModel : text(this.provider === "claude" ? record(row.message).model : p.model);
      if (this.provider === "claude") this.observeModel(model, at);
      if (checkpointRequest) this.pending = checkpointRequest;
      this.request(observation, antigravity ? agyUsageAt ?? providerTiming?.end ?? timestamp(row.completed_at) : at,
        model, timing, antigravity ? { start: providerTiming?.start ?? at, checkpoint } : undefined);
    }
    if (row.type === "event_msg" && p.type === "thread_settings_applied") this.observeModel(text(p.model), at);
    const close = row.type === "event_msg" && ["task_complete", "task_completed", "turn_aborted"].includes(text(p.type))
      ? p.type === "turn_aborted" ? "abort" : "complete"
      : row.type === "system" && row.subtype === "turn_duration" ? "complete" : undefined;
    const statisticsAt = messages.reduce((latest, message) => Math.max(latest, message.toolTimes?.end ?? 0),
      Math.max(at, providerTiming?.end ?? 0, agyUsageAt ?? 0));
    this.statistics.observe({ line: this.line, at: statisticsAt,
      turn: this.turn, firstNode,
      nodes: replayed ? [] : this.nodes.slice(firstNode), requestId: observation?.id,
      responseKey: this.provider === "claude" && row.type === "assistant" ? text(record(row.message).id) || undefined : undefined,
      turnStart: row.type === "turn_context" || row.type === "event_msg" && p.type === "task_started"
        || !!antigravity && hasUser,
      close: close ?? (antigravity && row.type === "ERROR_MESSAGE" ? "interrupt" : undefined) });
  }
  summary(agent: Agent, source: Summary["source"] = "native"): Summary {
    const s = this.meter.stats, usage = { ...this.meter.usage }, usageSources = { ...this.meter.usageSources };
    const sorted = (map: Map<string, Tally>) => [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const intervals: NonNullable<Summary["intervals"]> = [...this.toolIntervals.values()];
    for (const request of this.requests) {
      const start = request.providerTiming?.start ?? request.estimatedModelStart;
      const end = request.providerTiming?.end ?? request.estimatedModelEnd;
      if (start !== undefined && end !== undefined && end >= start) intervals.push({ start, end, kind: "model" });
    }
    return { agent: { ...agent, model: this.model || agent.model }, source, usage, usageSources,
      turns: this.antigravityCalls ? this.humanInputs || s.turns : s.turns || this.turn || this.humanInputs,
      steps: s.steps || this.requests.length, humanInputs: this.humanInputs,
      toolCalls: this.toolCallCount, images: this.images,
      contextTokens: this.contextTokens, contextWindow: this.contextWindow, maxOutput: this.maxOutput,
      ...(this.contextTokens === null ? {} : { contextSource: "reported" }),
      parts: { ...this.active }, costUsd: null, costComplete: false,
      modelMs: this.modelMs, toolMs: [...this.toolDurations.values()].reduce((n, duration) => n + duration, 0),
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
      if (!(at > 0)) return;
      const date = new Date(at); date.setHours(0, 0, 0, 0); const time = date.getTime();
      const day = days.get(time) ?? { time, tools: new Map(), skills: new Map(), programs: new Map() };
      this.tally(day[kind], name, at); days.set(time, day);
    };
    for (const node of this.nodes) if (!node.replayed && node.category === "calls" && node.tool) add("tools", node.tool, node.time);
    for (const event of this.events) if (event.kind === "skill") add("skills", event.title, event.time);
    for (const command of this.commands) for (const program of command.programs) add("programs", program, command.time);
    return [...days.values()].map((day) => ({ time: day.time, tools: [...day.tools.values()], skills: [...day.skills.values()], programs: [...day.programs.values()] }));
  }
}
