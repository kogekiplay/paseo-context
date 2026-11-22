import { emptyStats, type Stats } from "./meter-stats";
import { emptyUsage, type ProviderTiming, type Usage } from "../shared/contracts";
import type { UsageSource, UsageSources } from "../shared/core/types";
import { cumulativeDelta, requestUsage, sourcesOfUsage, usageBuckets, usageKeys, type NativeUsageProvider } from "./usage-fields";
import { antigravityStepIndex, mergeAntigravityUsage, type AntigravityStep } from "./antigravity-log";
import { count, record, stringBytes, stringIndexBytes, text, timestamp, type RecordValue } from "./value";

export interface UsageObservation {
  id: string;
  usage: Usage;
  sources: UsageSources;
}
type ResponseUsage = UsageObservation & { buckets: Partial<Usage> };
const rowTime = (row: RecordValue) => timestamp(row.timestamp ?? row.createdAt) || NaN;

/** Folds complete JSONL lines; content and tool arguments are never retained. */
export class SessionFold {
  readonly stats: Stats;
  readonly usage = emptyUsage();
  readonly usageSources: UsageSources = {};
  lastTiming: { start: number; end: number; modelMs: number; ttftMs?: number } | null = null;
  lastProviderTiming: ProviderTiming | null = null;
  lastUsage: UsageObservation | null = null;
  private turn = "initial";
  private turns = new Set<string>();
  private responses = new Map<string, ResponseUsage>();
  private modern = false;
  private lastCumulative: Partial<Usage> | null = null;
  private lastLegacySignature = "";
  private requestGeneration = 0;
  private boundary = NaN;
  private requestStart: number | null = null;
  private firstOutput: number | null = null;
  private firstKind: "text" | "tool" | null = null;
  private lastUsageAt = NaN;
  private lastModelOutput = NaN;
  private toolsAfterOutput = false;
  private pendingTools = new Map<string, number>();
  private timings = new Map<string, { tokens: number; ms: number }>();
  private chain = new Map<string, { parent: string | null; at: number; attachment: boolean }>();
  private claudeStarts = new Map<string, { start: number; first: number | null }>();
  private claudeTtft = new Set<string>();
  private antigravityResponses = new Map<string, string>();
  private antigravityTiming = new Map<string, ProviderTiming>();

  get residentBytes() {
    let bytes = 768 + stringBytes(this.turn) + stringBytes(this.lastLegacySignature)
      + stringIndexBytes(this.turns) + stringIndexBytes(this.claudeTtft);
    for (const map of [this.responses, this.pendingTools, this.timings, this.chain, this.claudeStarts,
      this.antigravityResponses, this.antigravityTiming]) bytes += stringIndexBytes(map.keys());
    for (const { parent } of this.chain.values()) bytes += 80 + stringBytes(parent);
    for (const id of this.antigravityResponses.values()) bytes += stringBytes(id);
    return bytes + this.responses.size * 320 + this.timings.size * 56
      + this.claudeStarts.size * 56 + this.antigravityTiming.size * 96;
  }

  constructor(readonly provider: NativeUsageProvider) {
    this.stats = emptyStats(provider);
  }

  private addTurn() {
    this.turns.add(this.turn);
    this.stats.turns = this.turns.size;
  }
  private timed(id: string, output: number, end: number) {
    const usageAt = end;
    const start = this.requestStart ?? this.boundary;
    // Older Codex can flush usage after waiting for tools. Its last model
    // output is the conservative response endpoint (CC Switch's boundary rule).
    if (this.toolsAfterOutput) end = this.lastModelOutput;
    const ms = end - start;
    if (Number.isFinite(ms) && ms >= 100 && ms <= 3_600_000 && output > 0) {
      this.updateTiming(id, ms, output);
      const first = this.firstOutput === null ? NaN : this.firstOutput - start;
      this.lastTiming = { start, end, modelMs: ms };
      if (this.firstKind === "text" && first > 0 && first <= ms) {
        this.stats.ttftMs += first;
        this.stats.ttftSteps++;
        this.lastTiming.ttftMs = first;
      }
    }
    // When a flush follows a tool result, that result remains the next
    // observable inference boundary even if the flush was recorded later.
    if (!this.toolsAfterOutput || !Number.isFinite(this.boundary)) {
      this.boundary = Math.max(usageAt, Number.isFinite(this.boundary) ? this.boundary : usageAt);
    }
    this.lastUsageAt = usageAt;
    this.requestStart = null;
    this.firstOutput = null;
    this.firstKind = null;
    this.lastModelOutput = NaN;
    this.toolsAfterOutput = false;
  }
  private updateTiming(id: string, ms: number, output: number) {
    const prior = this.timings.get(id);
    this.stats.modelMs += ms - (prior?.ms ?? 0);
    this.stats.timedOutputTokens += output - (prior?.tokens ?? 0);
    this.timings.set(id, { tokens: output, ms });
  }

  private recordUsage(id: string, patch: Partial<Usage>, source: UsageSource) {
    const previous = this.responses.get(id);
    const buckets = { ...previous?.buckets, ...patch };
    const sources = { ...previous?.sources, ...sourcesOfUsage(patch, source) };
    const usage = requestUsage(buckets, this.provider);
    this.responses.set(id, { id, buckets, usage, sources });
    this.lastUsage = { id, usage, sources };
    for (const key of usageKeys) {
      this.usage[key] += usage[key] - (previous?.usage[key] ?? 0);
      const lane = sources[key], prior = this.usageSources[key];
      if (lane) this.usageSources[key] = prior && prior !== lane ? "mixed" : lane;
    }
    this.stats.inputTokens = this.usage.input;
    this.stats.cachedTokens = this.usage.cacheRead;
    this.stats.cacheWriteTokens = this.usage.cacheWrite;
    this.stats.outputTokens = this.usage.output;
    this.stats.steps = this.responses.size;
    if (!previous) this.addTurn();
    return usage;
  }

  apply(value: unknown, line: number, native?: AntigravityStep) {
    this.lastTiming = null;
    this.lastProviderTiming = null;
    this.lastUsage = null;
    const row = record(value);
    if (this.provider === "codex") this.codex(row, line);
    else if (this.provider === "claude") this.claudeRow(row, line);
    else this.antigravityRow(row, line, native);
  }

  private antigravityRow(row: RecordValue, line: number, native?: AntigravityStep) {
    const index = antigravityStepIndex(row.step_index) ?? `line:${line}`;
    if (row.type === "USER_INPUT") {
      if (!row.source || row.source === "USER_EXPLICIT") this.turn = `agy:${index}`;
      return;
    }
    if (row.type !== "PLANNER_RESPONSE" && row.type !== "CHECKPOINT") return;
    const facts = native?.type === "PLANNER_RESPONSE" || native?.type === "CHECKPOINT" ? native : undefined;
    const buckets = mergeAntigravityUsage(usageBuckets(row, "antigravity"), facts?.usage);
    if (row.type === "CHECKPOINT" && !Object.keys(buckets).length) return;
    const responseId = facts?.responseId || text(row.response_id);
    const stepId = `agy:${index}`;
    const id = responseId ? this.antigravityResponses.get(responseId) ?? stepId : stepId;
    if (responseId) this.antigravityResponses.set(responseId, id);
    const usage = this.recordUsage(id, buckets, "reported");
    const prior = this.antigravityTiming.get(id), timing = facts?.timing;
    if (!timing && !prior) return;
    const modelMs = timing?.modelMs ?? prior?.modelMs;
    const start = timing?.start ?? prior?.start ?? (timestamp(row.created_at) || undefined);
    const end = timing?.end ?? (start !== undefined && timing?.modelMs !== undefined ? start + timing.modelMs : prior?.end);
    const first = timing?.ttftMs ?? prior?.ttftMs;
    const ttftMs = first !== undefined && (modelMs === undefined || first <= modelMs) ? first : undefined;
    if (modelMs !== undefined) this.updateTiming(id, modelMs, usage.output);
    this.stats.ttftMs += (ttftMs ?? 0) - (prior?.ttftMs ?? 0);
    this.stats.ttftSteps += Number(ttftMs !== undefined) - Number(prior?.ttftMs !== undefined);
    this.lastProviderTiming = { start, end, modelMs, ttftMs };
    this.antigravityTiming.set(id, this.lastProviderTiming);
  }
  private codex(row: RecordValue, line: number) {
    const p = record(row.payload),
      at = rowTime(row);
    if (row.type === "event_msg") {
      if (p.type === "task_started") {
        this.requestGeneration++;
        this.turn = typeof p.turn_id === "string" ? p.turn_id : String(row.timestamp);
        this.boundary = at;
        this.pendingTools.clear();
        this.requestStart = null;
        this.firstOutput = null;
        this.firstKind = null;
        this.lastModelOutput = NaN;
        this.toolsAfterOutput = false;
        this.lastUsageAt = NaN;
      }
      if (p.type === "task_complete" || p.type === "task_completed" || p.type === "turn_aborted") {
        this.boundary = NaN;
        this.pendingTools.clear();
        this.requestStart = null;
        this.firstOutput = null;
        this.firstKind = null;
        this.lastModelOutput = NaN;
        this.toolsAfterOutput = false;
      }
      if (p.type === "item_completed") {
        const item = record(p.item);
        if (
          (item.type === "Reasoning" || item.type === "AgentMessage") &&
          typeof p.started_at_ms === "number" &&
          Number.isFinite(p.started_at_ms)
        ) {
          if (this.requestStart === null) this.requestGeneration++;
          this.requestStart ??= this.boundary;
          this.firstKind ??= "text";
          this.firstOutput = Math.min(this.firstOutput ?? p.started_at_ms, p.started_at_ms);
        }
      }
      if (p.type !== "token_count" || this.modern) return;
      const info = record(p.info);
      if (!info.total_token_usage && !info.last_token_usage) return;
      const signature = JSON.stringify([this.turn, this.requestGeneration, info.total_token_usage, info.last_token_usage]);
      if (signature === this.lastLegacySignature) return;
      this.lastLegacySignature = signature;
      const exact = usageBuckets(info.last_token_usage, "codex");
      const cumulative = usageBuckets(info.total_token_usage, "codex");
      const hasExact = Object.keys(exact).length > 0;
      // Cumulative lanes may advance independently of an exact response. Only
      // use their deltas when the record has no exact response buckets.
      const buckets = hasExact ? exact : cumulativeDelta(cumulative, this.lastCumulative);
      if (info.total_token_usage && Object.keys(cumulative).length > 0) this.lastCumulative = cumulative;
      if (Object.keys(buckets).length === 0) return;
      if (!hasExact && this.requestStart === null && !Object.values(buckets).some((value) => value > 0)) return;
      const id = `legacy:${line}`;
      const usage = this.recordUsage(id, buckets, hasExact ? "reported" : "cumulative");
      this.timed(id, usage.output, at);
    }
    if (row.type === "turn_context") {
      if (typeof p.turn_id === "string") this.turn = p.turn_id;
      if (Number.isFinite(at)) this.boundary = at;
    }
    if (row.type === "token_usage_record") {
      const id = text(p.response_id) || String(row.ordinal ?? row.timestamp ?? line);
      const existing = this.responses.has(id);
      this.modern = true;
      if (!existing && typeof p.turn_id === "string") this.turn = p.turn_id;
      const usage = this.recordUsage(id, usageBuckets(p.usage, "codex"), "reported");
      if (!existing) this.timed(id, usage.output, at);
      else {
        const timing = this.timings.get(id);
        if (timing && timing.tokens !== usage.output) this.updateTiming(id, timing.ms, usage.output);
      }
    }
    if (row.type === "response_item") {
      const output =
        p.type === "reasoning" ||
        (p.type === "message" && p.role === "assistant") ||
        p.type === "function_call" ||
        p.type === "custom_tool_call";
      if (
        output &&
        !(this.requestStart === null && at - this.lastUsageAt >= 0 && at - this.lastUsageAt <= 100)
      ) {
        if (this.requestStart === null) this.requestGeneration++;
        this.requestStart ??= this.boundary;
        this.firstKind ??=
          p.type === "function_call" || p.type === "custom_tool_call" ? "tool" : "text";
        this.lastModelOutput = at;
        this.toolsAfterOutput = false;
      }
      if (p.type === "message" && p.role !== "assistant" && Number.isFinite(at)) this.boundary = at;
      if (
        (p.type === "function_call" || p.type === "custom_tool_call") &&
        typeof p.call_id === "string"
      ) {
        this.pendingTools.set(p.call_id, at);
      }
      if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        if (Number.isFinite(this.lastModelOutput)) this.toolsAfterOutput = true;
        if (typeof p.call_id === "string") this.finishTool(p.call_id, at);
        // A parallel batch resumes inference after its last result, not its first.
        if (this.pendingTools.size === 0) this.boundary = at;
      }
    }
  }

  private finishTool(id: string, end: number) {
    const start = this.pendingTools.get(id);
    if (start !== undefined && Number.isFinite(end - start))
      this.stats.toolMs += Math.max(0, end - start);
    this.pendingTools.delete(id);
  }

  private claudeRow(row: RecordValue, line: number) {
    if (row.isSidechain === true || row.isApiErrorMessage === true) return;
    const msg = record(row.message),
      at = rowTime(row);
    if (typeof row.uuid === "string")
      this.chain.set(row.uuid, {
        parent: typeof row.parentUuid === "string" ? row.parentUuid : null,
        at,
        attachment: row.type === "attachment",
      });
    const content = Array.isArray(msg.content) ? msg.content.map(record) : [];
    if (row.type === "user") {
      for (const block of content) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string")
          this.finishTool(block.tool_use_id, at);
      }
      if (!content.some((c) => c.type === "tool_result") && row.isMeta !== true) {
        this.turn = typeof row.uuid === "string" ? row.uuid : String(row.timestamp);
      }
      this.boundary = at;
    }
    if (row.type !== "assistant") return;
    for (const block of content) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        !this.pendingTools.has(block.id)
      )
        this.pendingTools.set(block.id, at);
    }
    const id = text(msg.id) || String(line);
    let timing = this.claudeStarts.get(id);
    if (!timing) {
      let parent = typeof row.parentUuid === "string" ? row.parentUuid : null;
      let start = this.boundary;
      for (let hop = 0; parent && hop < 32; hop++) {
        const node = this.chain.get(parent);
        if (!node) break;
        if (!node.attachment) {
          start = node.at;
          break;
        }
        parent = node.parent;
      }
      const firstBlock = row.apiBlockIndex === undefined || row.apiBlockIndex === 0;
      if (!firstBlock) start = NaN;
      const duration = count(row.thinkingDurationMs);
      const first =
        firstBlock && content[0]?.type === "thinking" && duration > 0 ? at - duration : null;
      timing = { start, first };
      this.claudeStarts.set(id, timing);
    }
    if (!msg.usage) return;
    const usage = this.recordUsage(id, usageBuckets(msg.usage, "claude"), "reported");
    const ms = at - timing.start;
    if (Number.isFinite(ms) && ms >= 100 && ms <= 3_600_000) {
      this.updateTiming(id, ms, usage.output);
      this.lastTiming = { start: timing.start, end: at, modelMs: ms };
    }
    const first = timing.first === null ? NaN : timing.first - timing.start;
    if (
      typeof msg.stop_reason === "string" &&
      !this.claudeTtft.has(id) &&
      ms >= 100 &&
      ms <= 3_600_000 &&
      first > 0 &&
      first <= ms
    ) {
      this.claudeTtft.add(id);
      this.stats.ttftMs += first;
      this.stats.ttftSteps++;
    }
    if (this.lastTiming && first > 0 && first <= ms) this.lastTiming.ttftMs = first;
  }
}
