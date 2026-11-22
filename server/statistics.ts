import type { StatsCall, StatsCompactionMetrics, StatsEventMetrics, StatsSnapshot, StatsStepMetrics } from "../shared/core/stats-contract";
import { aggregateTurn } from "../shared/core/stats-aggregate";
import { toolSpanUnion } from "../shared/core/stats-tools";
import { nodeSeq, type Loaded } from "./upstream";
import { statisticsRows } from "./statistics-rows";
import { observedUsage, usageSourceOf } from "../shared/usage";

/** Project captured Paseo/native facts onto the original table's static model. */
export function statisticsOf(data: Loaded): StatsSnapshot {
  const { fold, summary } = data;
  const hasUsage = !summary.notices.includes("usage-unavailable") && summary.source !== "unavailable";
  const commands = new Map(fold.commands.map((command) => [command.id, command]));
  const filesByNode = new Map<number, typeof fold.files>();
  for (const file of fold.files) {
    const files = filesByNode.get(file.id) ?? [];
    files.push(file); filesByNode.set(file.id, files);
  }
  const rows = statisticsRows(data);
  const firstByTurn = new Map<number, typeof rows[number]>();
  const steps = new Map<number, StatsStepMetrics[]>();
  for (const row of rows) {
    const { span, request, nodes, results, revision } = row;
    if (!firstByTurn.has(span.turn)) firstByTurn.set(span.turn, row);
    const calls: StatsCall[] = nodes.filter((node) => node.category === "calls").map((node) => {
      const result = node.callId ? results.get(node.callId) : undefined;
      const command = commands.get(node.id);
      const files = filesByNode.get(node.id) ?? [];
      const duration = result?.toolDurationMs ?? null;
      const paired = result && node.time > 0 && result.time >= node.time
        && (summary.source !== "timeline" || node.line !== result.line);
      return {
        callId: node.callId ?? `node:${node.id}`, seq: nodeSeq(fold, node.id), name: node.tool ?? null,
        hint: command?.command ?? files[0]?.path ?? null, chars: null, lines: null,
        error: result?.error === true || command?.status === "failed" || files.some((file) => file.error),
        added: files.length ? files.reduce((n, file) => n + file.added, 0) : null,
        removed: files.length ? files.reduce((n, file) => n + file.removed, 0) : null,
        before: null, after: null, args: null, inner: false,
        text: null, truncated: false,
        ms: duration,
        startedAt: node.time > 0 && (summary.source !== "timeline" || paired) ? node.time : null,
        endedAt: paired ? result.time : null,
      };
    });
    const measuredTools = calls.filter((call) => call.ms !== null);
    const field = (key: keyof NonNullable<typeof request>["usage"]) => hasUsage && request ? observedUsage(request, key) : null;
    const context = request && usageSourceOf(request, "input") === "reported" ? field("input") : null;
    const read = field("cacheRead"), output = field("output");
    const counts = new Map<string, number>();
    for (const call of calls) if (call.name) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    const previous = steps.get(span.turn) ?? [];
    const startTime = request?.time || span.start || null;
    const end = span.end ?? (request?.duration !== null && request?.duration !== undefined && request.time > 0 ? request.time + request.duration : null);
    const toolEnd = calls.reduce<number | null>((max, call) => call.endedAt === null ? max : Math.max(max ?? call.endedAt, call.endedAt), null);
    const endTime = end === null ? null : Math.max(end, toolEnd ?? end);
    const model = request?.estimatedModelMs ?? null, ttft = request?.estimatedTtftMs ?? null;
    const decode = model !== null && ttft !== null && model >= ttft ? model - ttft : null;
    const step: StatsStepMetrics = {
      sourceId: span.id, contentRevision: revision, detailsState: "unloaded", timingSource: model === null ? undefined : "session-estimate",
      ...(hasUsage && request?.usageSources ? { usageSources: request.usageSources } : {}),
      turn: span.turn, step: previous.length + 1, startTime, endTime,
      context, output, cacheRead: read, cacheWrite: field("cacheWrite"),
      cacheHit: context !== null && context > 0 && read !== null ? Math.min(1, read / context) : null,
      // Keep absent timing unknown. A request's entire elapsed interval also
      // includes tools/idle and must not be substituted for model latency.
      ttft, decode, tps: decode !== null && decode > 0 && output !== null ? output / (decode / 1000) : null, model,
      tool: measuredTools.length ? measuredTools.reduce((n, call) => n + call.ms!, 0) : calls.length ? null : 0,
      toolWall: toolSpanUnion(calls), toolPending: calls.filter((call) => !results.has(call.callId)).length,
      tools: [...counts].map(([name, count]) => ({ name, count })), calls: calls.slice(0, 12), toolOutput: null,
      retries: 0, toolErrors: calls.filter((call) => call.error).length,
      answer: nodes.filter((node) => node.category === "assistant").map((node) => node.preview).join("\n").slice(0, 240) || null,
      answerBody: null,
      answerTruncated: nodes.some((node) => node.category === "assistant" && node.preview.length >= 180),
      wall: endTime !== null && startTime !== null ? Math.max(0, endTime - startTime) : null,
      running: !span.closed && summary.agent.running, interrupted: span.interrupted, aborted: span.aborted,
    };
    previous.push(step); steps.set(span.turn, previous);
  }
  const firsts = [...firstByTurn.values()];
  const turns = [...steps].map(([turn, rows], index) => {
    const first = firstByTurn.get(turn)!;
    const next = firsts[index + 1];
    const events = fold.events.filter((event) => event.time >= first.span.start && (!next || event.time < next.span.start));
    const compactions: StatsCompactionMetrics[] = events.filter((event) => event.kind === "compaction").map((event) => ({
      compactionId: String(event.id), turn, startTime: event.time, endTime: null, wall: null, running: false,
      context: null, output: null, cacheHit: null, cacheRead: null, cacheWrite: null,
      provider: summary.agent.provider, model: null, shadowedTokens: null, summaryChars: null, error: null,
    }));
    const other: StatsEventMetrics[] = events.filter((event) => event.kind !== "compaction").map((event) => ({
      kind: event.kind === "prune" ? "context-prune" : "context-refresh", turn, step: null, time: event.time,
      reason: event.title, series: false, provider: null, model: null, toolCount: null, surfaceOp: null,
      chars: null, added: [], removed: [], shadowedTokens: null, status: null, retry: null,
      delayMs: null, error: null, label: event.detail || event.title,
    }));
    return { ...aggregateTurn(turn, rows), prompt: first.span.prompt || first.request?.prompt || null, promptSource: first.span.prompt ? "user" : null, compactions, events: other };
  });
  return { turns, stepCount: rows.length };
}
