import type { Agent, Parts, Summary } from "../shared/contracts";
import type { ContextHeaders, ContextTimeline, HeaderRecord, SessionCostUsage, SurfaceNode } from "../shared/core/types";
import type { ContextService } from "./service";
import { toolKind } from "./normalize";
import type { ContextFold } from "./fold";
import { spansOf, timingOf } from "./timing";
import { reportedUsageOf } from "../shared/usage";
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
export function costOf(s: Summary): SessionCostUsage {
  return { [s.agent.provider]: { [s.agent.model]: { off: {
    uncached: Math.max(0, s.usage.input - s.usage.cacheRead - s.usage.cacheWrite),
    cacheRead: s.usage.cacheRead, cacheWrite: s.usage.cacheWrite, output: s.usage.output,
  } } } };
}
export function rowOf(a: Agent, head?: ContextTimeline) {
  return { id: a.id, title: a.title, displayTitle: a.title, cwd: a.cwd, createdAt: a.createdAt, updatedAt: a.updatedAt,
    running: a.running, blank: false, archived: a.archived, ...(a.parentId ? { parentId: a.parentId, origin: "subagent" } : {}),
    projectionValues: head ? { contextTimeline: head, tokenUsage: reportedUsageOf(head), contextPressure: {
      pressureTokens: head.last?.prompt, contextWindow: head.contextWindow,
    }, subagentTiming: { settledMs: head.timing?.wallMs ?? 0 } } : {} };
}
export type Loaded = Awaited<ReturnType<ContextService["load"]>>;
export function upstreamOf(data: Loaded): { head: ContextTimeline; headers: ContextHeaders } {
  const { summary: s, fold } = data;
  const hasUsage = data.requests.length > 0 && !s.notices.includes("usage-unavailable") && s.source !== "unavailable";
  const all: SurfaceNode[] = fold.nodes.filter((n) => n.category !== "system" && n.category !== "tools").map((n) => ({
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
  const headers: ContextHeaders = { headers: fold.toolEpochs.map((epoch): HeaderRecord => ({
    seq: epoch.seq, time: epoch.time, tools: epoch.nodeIds.map((id) => {
      const node = fold.nodes[id];
      return { name: node.title, tokens: node.tokens, plugin: node.source || "provider" };
    }),
  })) };
  const turnSteps = new Map<number, number>();
  const current = currentOf(s.parts), requests = data.requests.map((r) => {
    const step = (turnSteps.get(r.turn) ?? 0) + 1;
    turnSteps.set(r.turn, step);
    return {
    ...currentOf(r.parts), seq: r.seq ?? r.boundary * 10 + 1 - 1 / (r.index + 1),
    time: r.time, total: Object.values(r.parts).reduce((a, b) => a + b, 0),
    ...(hasUsage ? { prompt: r.usage.input, output: r.usage.output, cacheRead: r.usage.cacheRead } : {}), turn: r.turn, step,
    ...(r.duration === null ? {} : { activeMs: r.duration }),
  }; });
  const head: ContextTimeline = {
    ok: true, model: s.agent.model, provider: s.agent.provider,
    ...(s.contextWindow === null ? {} : { contextWindow: s.contextWindow }),
    ...(s.maxOutput === null ? {} : { maxOutputTokens: s.maxOutput }),
    current, nodes, archive, droppedNodes: 0, requests,
    last: { seq: requests.at(-1)?.seq ?? 0, total: current.total, ...(s.contextTokens === null ? {} : { prompt: s.contextTokens }) },
    humanInputs: s.humanInputs, answers: fold.nodes.filter((n) => n.category === "assistant").length,
    images: s.images, generatedReasoning: s.usage.reasoning, generatedAnswerTokens: Math.max(0, s.usage.output - s.usage.reasoning),
    toolCalls: s.toolCalls, toolTally: Object.fromEntries(s.tools.map((t) => [t.name, t.count])),
    programTally: Object.fromEntries(s.programs.map((t) => [t.name, t.count])),
    counts: { turns: s.turns, steps: s.steps, injects: fold.events.filter((e) => e.kind === "inject" || e.kind === "skill").length,
      compactions: fold.events.filter((e) => e.kind === "compaction").length, prunes: fold.events.filter((e) => e.kind === "prune").length,
      skills: s.skills.reduce((n, t) => n + t.count, 0), events: fold.events.length,
      modelSwitches: fold.events.filter((e) => e.kind === "model").length },
    events: fold.events.map((e) => {
      const seq = e.seq ?? nodeSeq(fold, fold.nodes.find((n) => n.time >= e.time)?.id ?? fold.nodes.length);
      const removed = fold.nodes.filter((node) => node.goneSeq === seq);
      const gross = removed.reduce((n, node) => n + node.tokens, 0);
      const replacement = fold.nodes.filter((node) => node.seq !== undefined && Math.floor(node.seq / 1_000_000) === Math.floor(seq / 1_000_000)).reduce((n, node) => n + node.tokens, 0);
      return { id: e.id, seq, time: e.time,
      kind: e.kind === "skill" ? "inject" : e.kind, name: e.title, detail: e.detail,
      ...(e.kind === "skill" ? { sub: "skill" } : {}),
      ...(e.kind === "model" ? { to: e.title, from: e.detail.split(" → ")[0] } : {}),
      ...(e.kind === "compaction" || e.kind === "prune" ? { count: removed.length, grossTokens: gross, tokens: Math.max(0, gross - replacement) } : {}),
    }; }),
    systems: fold.nodes.filter((n) => n.category === "system").map((n) => ({ seq: nodeSeq(fold, n.id), time: n.time, tokens: n.tokens })),
    fileOps: fold.files.map((f) => ({ seq: nodeSeq(fold, f.id), path: f.path, kind: f.kind === "image" ? "read" : f.kind,
      tool: toolKind(f.tool), time: f.time, err: f.error, added: f.added, removed: f.removed })),
    commands: fold.commands.map((c) => ({ seq: nodeSeq(fold, c.id), time: c.time, tool: toolKind(c.tool), cmd: c.command, cwd: c.cwd || s.agent.cwd,
      start: c.time, ...(c.duration === null ? {} : { end: c.time + c.duration }), status: c.status,
      ...(c.exit === null ? {} : { exit: c.exit }), err: c.status === "failed",
      ...(c.outputNode === null ? {} : { resultSeq: nodeSeq(fold, c.outputNode) }) })),
    commandStats: { runs: fold.commands.length, failed: fold.commands.filter((c) => c.status === "failed").length,
      ms: fold.commands.reduce((n, c) => n + (c.duration ?? 0), 0), bg: fold.commands.filter((c) => c.status === "running").length },
    timing: timingOf(s), spans: spansOf(s.intervals ?? []),
    ...(hasUsage ? { cost: costOf(s) } : {}), costRead: { usd: s.costUsd, ready: true }, detailRev: data.revision,
  };
  return { head, headers };
}
