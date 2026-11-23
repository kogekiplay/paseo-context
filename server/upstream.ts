import type { Agent, Parts, Request } from "../shared/contracts";
import type { ContextHeaders, ContextTimeline, ContextTimelineDetail, HeaderRecord, RequestRecord, SessionCostUsage, SurfaceNode } from "../shared/core/types";
import { attachTurnSpans } from "../shared/core/turnSpans";
import type { LoadedSession } from "./service";
import { toolKind } from "./normalize";
import type { ContextFold } from "./fold";
import { spansOf, timingOf } from "./timing";
import { observedUsage, reportedUsageOf, usageSourceOf } from "../shared/usage";
export { timingOf } from "./timing";

export const seqOf = (id: number) => id * 10 + 2;
export const idOf = (seq: number) => Math.floor(seq / 10);
export const nodeSeq = (fold: ContextFold, id: number) => fold.nodes[id]?.seq ?? seqOf(id);
export function currentOf(parts: Parts): ContextTimeline["current"] {
  const { system, tools, user, inject, skill, assistant, reasoning, calls, tool } = parts;
  return { system, tools, user, inject, skill, assistant: assistant + reasoning + calls,
    assistantReasoning: reasoning, assistantAnswerTokens: assistant, assistantCallTokens: calls,
    tool, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}
function costOf(provider: string, requests: Request[]): SessionCostUsage | undefined {
  if (!requests.length || requests.some((r) => !usageSourceOf(r, "input") || !usageSourceOf(r, "output") || r.usage.cacheRead + r.usage.cacheWrite > r.usage.input)) return undefined;
  const models: SessionCostUsage[string] = Object.create(null);
  for (const { model, usage } of requests) {
    const row = (models[model] ??= { off: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }).off!;
    row.uncached += Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
    row.cacheRead += usage.cacheRead;
    row.cacheWrite += usage.cacheWrite;
    row.output += usage.output;
  }
  return { [provider]: models };
}
export function rowOf(a: Agent, head?: ContextTimeline) {
  return { id: a.id, title: a.title, displayTitle: a.title, cwd: a.cwd, createdAt: a.createdAt, updatedAt: a.updatedAt,
    running: a.running, blank: false, archived: a.archived, ...(a.parentId ? { parentId: a.parentId, origin: "subagent" } : {}),
    projectionValues: head ? { contextTimeline: head, tokenUsage: reportedUsageOf(head), contextPressure: {
      pressureTokens: head.last?.prompt, contextWindow: head.contextWindow,
    }, subagentTiming: { settledMs: head.timing?.wallMs ?? 0 } } : {} };
}
function eventsOf(fold: ContextFold, requests: readonly RequestRecord[]): ContextTimeline["events"] {
  const removals = new Map<number, { count: number; tokens: number }>();
  const replacements = new Map<number, number>();
  for (const node of fold.nodes) {
    if (node.goneSeq !== undefined) {
      const removed = removals.get(node.goneSeq) ?? { count: 0, tokens: 0 };
      removed.count++;
      removed.tokens += node.tokens;
      removals.set(node.goneSeq, removed);
    }
    if (node.replayed || node.category === "inject") replacements.set(node.line, (replacements.get(node.line) ?? 0) + node.tokens);
  }
  const events = fold.events.map((event, index): ContextTimeline["events"][number] => {
    const seq = event.seq;
    const removed = removals.get(seq);
    const gross = removed?.tokens ?? 0, replacement = replacements.get(Math.floor(seq / 1_000_000)) ?? 0;
    return { id: event.id, seq, ord: event.ord ?? index, time: event.time, kind: event.kind === "skill" ? "inject" : event.kind,
      name: event.title, detail: event.detail, ...(event.kind === "skill" ? { sub: "skill" } : {}),
      ...(event.count === undefined ? {} : { count: event.count }),
      ...(event.items === undefined ? {} : { items: event.items }),
      ...(event.agent === undefined ? {} : { agent: event.agent }),
      ...(event.kind === "model" ? { to: event.title, from: event.detail.split(" → ")[0] } : {}),
      ...(event.kind === "compaction" || event.kind === "prune"
        ? { count: removed?.count ?? 0, grossTokens: gross, tokens: Math.max(0, gross - replacement) } : {}) };
  });
  return attachTurnSpans(events, requests);
}

const requestSeq = (r: Request) => r.seq ?? r.boundary * 10 + 1;
export type Loaded = LoadedSession;
export function upstreamOf(data: Loaded, graph = false): { head: ContextTimeline; headers: ContextHeaders } {
  const { summary: s, fold } = data;
  const hasUsage = !s.notices.includes("usage-unavailable") && s.source !== "unavailable";
  const all: SurfaceNode[] = graph ? [] : fold.nodes.filter((n) => n.category !== "system" && n.category !== "tools").map((n) => ({
    seq: nodeSeq(fold, n.id), time: n.time, cat: n.category === "reasoning" || n.category === "calls" ? "assistant" : n.category as SurfaceNode["cat"],
    tokens: n.tokens, ...(n.category === "reasoning" ? { reasoning: n.tokens } : {}),
    ...(n.category === "assistant" ? { answerTokens: n.tokens } : {}),
    ...(n.category === "calls" ? { callTokens: n.tokens, calls: n.tool ? [n.tool] : [] } : {}),
    ...(n.images ? { imgs: n.images } : {}),
    ...(n.gone === undefined ? {} : { gone: n.goneSeq ?? n.gone * 10 + 1 }),
    name: n.title, text: n.preview, ...(n.tool ? { tool: n.tool } : {}),
    ...(n.category === "skill" ? { skill: n.title } : {}),
  }));
  const nodes = all.filter((n) => n.gone === undefined), archive = all.filter((n) => n.gone !== undefined);
  const headers: ContextHeaders = { headers: graph ? [] : fold.toolEpochs.map((epoch): HeaderRecord => ({
    seq: epoch.seq, time: epoch.time, tools: epoch.nodeIds.map((id) => {
      const node = fold.nodes[id];
      return { name: node.title, tokens: node.tokens, plugin: node.source || "provider" };
    }),
  })) };
  const turnSteps = new Map<number, number>();
  const current = currentOf(s.parts), requests = graph ? [] : data.requests.map((r) => {
    const step = (turnSteps.get(r.turn) ?? 0) + 1;
    turnSteps.set(r.turn, step);
    const output = hasUsage ? observedUsage(r, "output") : null;
    const cacheRead = hasUsage ? observedUsage(r, "cacheRead") : null;
    return {
      ...currentOf(r.parts), seq: requestSeq(r), time: r.time, turn: r.turn, step,
      ...(hasUsage && usageSourceOf(r, "input") === "reported" ? { prompt: r.usage.input } : {}),
      ...(output === null ? {} : { output }), ...(cacheRead === null ? {} : { cacheRead }),
      ...(hasUsage && r.usageSources ? { usageSources: r.usageSources } : {}),
      ...(r.duration === null ? {} : { activeMs: r.duration }),
    };
  });
  if (requests.some((row, index) => index > 0 && row.seq < requests[index - 1].seq)) {
    requests.sort((a, b) => a.seq - b.seq);
  }
  const last = data.requests.at(-1), cost = hasUsage ? costOf(s.agent.provider, data.requests) : undefined;
  const hasTiming = fold.hasToolTiming || s.source !== "timeline" &&
    (s.agent.provider !== "antigravity" || s.modelMs > 0 || (s.ttftMs ?? 0) > 0);
  const head: ContextTimeline = {
    ok: true, model: s.agent.model, provider: s.agent.provider,
    ...(s.contextWindow === null ? {} : { contextWindow: s.contextWindow }),
    ...(s.maxOutput === null ? {} : { maxOutputTokens: s.maxOutput }),
    current, nodes, archive, droppedNodes: 0, requests,
    last: { seq: last ? requestSeq(last) : 0, total: current.total,
      ...(s.contextTokens === null ? {} : { prompt: s.contextTokens, contextSource: s.contextSource }) },
    humanInputs: s.humanInputs, answers: fold.nodes.filter((n) => n.category === "assistant" && !n.replayed).length,
    images: s.images, generatedReasoning: s.usage.reasoning, generatedAnswerTokens: Math.max(0, s.usage.output - s.usage.reasoning),
    toolCalls: s.toolCalls, toolTally: Object.fromEntries(s.tools.map((t) => [t.name, t.count])),
    programTally: Object.fromEntries(s.programs.map((t) => [t.name, t.count])),
    counts: { turns: s.turns, steps: s.steps, injects: fold.events.filter((e) => e.kind === "inject" || e.kind === "skill").length,
      compactions: fold.events.filter((e) => e.kind === "compaction").length, prunes: fold.events.filter((e) => e.kind === "prune").length,
      skills: s.skills.reduce((n, t) => n + t.count, 0), events: fold.events.length,
      modelSwitches: fold.events.filter((e) => e.kind === "model").length },
    events: graph ? [] : eventsOf(fold, requests),
    systems: graph ? [] : fold.nodes.filter((n) => n.category === "system").map((n) => ({ seq: nodeSeq(fold, n.id), time: n.time, tokens: n.tokens })),
    fileOps: graph ? [] : fold.files.map((f) => ({ seq: nodeSeq(fold, f.id), path: f.path, kind: f.kind === "image" ? "read" : f.kind,
      tool: toolKind(f.tool), time: f.time, err: f.error, added: f.added, removed: f.removed })),
    commands: graph ? [] : fold.commands.map((c) => ({ seq: nodeSeq(fold, c.id), time: c.time, tool: toolKind(c.tool), cmd: c.command, cwd: c.cwd || s.agent.cwd,
      start: c.time, ...(c.duration === null ? {} : { end: c.time + c.duration }), status: c.status,
      ...(c.exit === null ? {} : { exit: c.exit }), err: c.status === "failed",
      ...(c.outputNode === null ? {} : { resultSeq: nodeSeq(fold, c.outputNode) }) })),
    commandStats: { runs: fold.commands.length, failed: fold.commands.filter((c) => c.status === "failed").length,
      ms: fold.commands.reduce((n, c) => n + (c.duration ?? 0), 0), bg: fold.commands.filter((c) => c.status === "running").length },
    ...(hasTiming ? { timing: timingOf(s) } : {}),
    spans: graph ? [] : spansOf(s.intervals ?? []),
    ...(hasUsage && s.usageSources ? { usageSources: s.usageSources } : {}),
    ...(cost ? { cost } : {}), costRead: { usd: s.costUsd, ready: true }, ...(graph ? {} : { detailRev: data.revision }),
  };
  return { head, headers };
}

// The legacy detail reader takes descriptive fields from `head` and the
// collections from the top level of the same response.
export function detailOf(head: ContextTimeline, rev: number): ContextTimelineDetail {
  const { nodes, archive, droppedNodes, surfaceFloor, archiveFloor, requests, events,
    commands, commandsFloor, commandStats, fileOps, fileOpsFloor, spans, ...headline } = head;
  return {
    rev, head: { ...headline, nodes: [], archive: [], droppedNodes: 0, requests: [], events: [] },
    nodes, archive, droppedNodes, surfaceFloor, archiveFloor, requests, events,
    commands, commandsFloor, commandStats, fileOps, fileOpsFloor, spans,
  };
}
