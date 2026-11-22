import type { Summary } from "../shared/contracts";
import type { TimingSpan, TimingTotals } from "../shared/core/types";

type Interval = NonNullable<Summary["intervals"]>[number];
export function unionMs(intervals: readonly { start: number; end: number }[]) {
  const sorted = intervals.filter((s) => Number.isFinite(s.start) && s.end > s.start).slice().sort((a, b) => a.start - b.start);
  let total = 0, end = -Infinity;
  for (const row of sorted) { total += Math.max(0, row.end - Math.max(end, row.start)); end = Math.max(end, row.end); }
  return total;
}
export function scopedIntervals(intervals: readonly Interval[], start: number, end: number) {
  return intervals.map((row) => ({ ...row, start: Math.max(start, row.start), end: Math.min(end, row.end) })).filter((row) => row.end > row.start);
}
export function spansOf(intervals: readonly Interval[]): TimingSpan[] {
  const changes = new Map<number, { model: number; tools: number }>();
  for (const row of intervals) {
    if (!(row.end > row.start)) continue;
    for (const [time, direction] of [[row.start, 1], [row.end, -1]]) {
      const change = changes.get(time) ?? { model: 0, tools: 0 };
      change[row.kind] += direction; changes.set(time, change);
    }
  }
  const times = [...changes.keys()].sort((a, b) => a - b), spans: TimingSpan[] = [];
  let model = 0, tools = 0;
  for (let i = 0; i < times.length - 1; i++) {
    const start = times[i], end = times[i + 1], change = changes.get(start)!;
    model += change.model; tools += change.tools;
    if (model <= 0 && tools <= 0) continue;
    const kind = tools > 0 ? "tools" : "other", last = spans.at(-1);
    if (last?.kind === kind && last.end === start) last.end = end;
    else spans.push({ kind, start, end });
  }
  return spans;
}
export function timingOf(s: Summary): TimingTotals {
  const tools = (s.intervals ?? []).filter((row) => row.kind === "tools");
  const toolBusyMs = unionMs(tools);
  const providerTiming = s.agent.provider === "antigravity" && s.source === "native";
  const modelMs = providerTiming ? s.modelMs : Math.min(s.modelMs, Math.max(0, s.wallMs - toolBusyMs));
  const ttftMs = providerTiming ? s.ttftMs ?? 0 : Math.min(modelMs, s.ttftMs ?? 0);
  return { wallMs: s.wallMs, ttftMs, genMs: Math.max(0, modelMs - ttftMs), calls: s.steps,
    toolsMs: s.toolMs, toolBusyMs, toolCalls: s.toolCalls, tools: {},
    speedTokens: s.timedOutputTokens ?? 0, speedMs: s.modelMs };
}
export function sumTiming(all: readonly Summary[]): TimingTotals {
  const total: TimingTotals = { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {}, toolBusyMs: 0, speedTokens: 0, speedMs: 0 };
  for (const s of all) {
    const timing = timingOf(s);
    for (const key of ["wallMs", "ttftMs", "genMs", "calls", "toolsMs", "toolCalls", "toolBusyMs", "speedTokens", "speedMs"] as const) total[key] = (total[key] ?? 0) + (timing[key] ?? 0);
  }
  return total;
}
