import { categories, emptyParts, type Parts, type Request, type Scope, type Summary, type Tally } from "../shared/contracts";
import { dayKeyOf, shiftDayKey, startOfDayKey } from "../shared/core/days";
import { usageSourceOf } from "../shared/usage";
import { scopedIntervals, sumTiming, unionMs } from "./timing";
import { stringBytes } from "./value";

const PAGE_SIZE = 24;
type LedgerRequest = Pick<Request, "time" | "usageAt" | "turn" | "usage" | "usageFields" | "usageSources" | "parts" | "costUsd">;

interface DayBucket {
  day: string;
  at: number;
  calls: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  pairedInput: number;
  pairedRead: number;
  cost: number;
  priced: number;
  measured: boolean;
  measuredTokens: number;
  measuredCostComplete: boolean;
  parts: Parts;
  turns: Float64Array;
}

interface RequestDays {
  hasRequests: boolean;
  days: DayBucket[];
  undated: Float64Array;
}

export interface SessionShard extends RequestDays {
  summary: Summary;
  key: string;
  at: number;
  retry?: boolean;
  bytes: number;
}

type BuildingBucket = Omit<DayBucket, "turns"> & { turns: Set<number> };

function newBucket(day: string, at: number): BuildingBucket {
  return { day, at, calls: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, pairedInput: 0, pairedRead: 0, cost: 0, priced: 0,
    measured: false, measuredTokens: 0, measuredCostComplete: true, parts: emptyParts(), turns: new Set() };
}

function account(bucket: BuildingBucket, request: LedgerRequest) {
  const { input, output, cacheRead, reasoning } = request.usage;
  const hasInput = usageSourceOf(request, "input"), hasRead = usageSourceOf(request, "cacheRead");
  const tokens = input + output;
  bucket.calls++;
  bucket.turns.add(request.turn);
  bucket.tokens += tokens;
  bucket.input += input;
  bucket.output += output;
  bucket.cacheRead += cacheRead;
  if (hasInput && hasRead) {
    bucket.pairedInput += input;
    bucket.pairedRead += cacheRead;
  }
  if (request.costUsd !== null) {
    bucket.cost += request.costUsd;
    bucket.priced++;
  }
  if (hasInput || hasRead || usageSourceOf(request, "output") || usageSourceOf(request, "cacheWrite") || usageSourceOf(request, "reasoning")) {
    bucket.measured = true;
    bucket.measuredTokens += tokens;
    bucket.measuredCostComplete &&= request.costUsd !== null;
  }
  let sum = 0;
  for (const part of Object.values(request.parts)) sum += part;
  for (const key of categories) bucket.parts[key] += sum ? request.parts[key] / sum * input : 0;
  bucket.parts.assistant += Math.max(0, output - reasoning);
  bucket.parts.reasoning += reasoning;
}

function compactRequests(requests: readonly LedgerRequest[]): RequestDays {
  const calendar = new Map<string, { start: number; end: number; bucket?: BuildingBucket }>();
  const buckets: BuildingBucket[] = [], outsideMidnight = new Map<number, BuildingBucket>();
  const undated = new Set<number>();
  for (const request of requests) {
    const at = request.usageAt ?? request.time;
    const day = at > 0 ? dayKeyOf(at) : null;
    if (day === null) {
      // These rows only establish window eligibility. A missing timestamp
      // of 0 can count there, while NaN and infinities never match a window.
      if (Number.isFinite(at)) undated.add(at);
      continue;
    }
    let bounds = calendar.get(day);
    if (!bounds) {
      const midnight = startOfDayKey(day);
      bounds = { start: midnight === null ? Infinity : Math.max(0, midnight), end: startOfDayKey(shiftDayKey(day, 1) ?? "") ?? Infinity };
      calendar.set(day, bounds);
    }
    let bucket: BuildingBucket;
    if (at >= bounds.start && at < bounds.end) {
      if (!bounds.bucket) buckets.push(bounds.bucket = newBucket(day, bounds.start));
      bucket = bounds.bucket;
    } else {
      // Clock changes can cross midnight twice. Keep the calendar label for
      // the heatmap and the actual instant for those rows' window membership.
      let existing = outsideMidnight.get(at);
      if (!existing) {
        existing = newBucket(day, at);
        outsideMidnight.set(at, existing);
        buckets.push(existing);
      }
      bucket = existing;
    }
    account(bucket, request);
  }
  return { hasRequests: requests.length > 0, undated: Float64Array.from(undated),
    days: buckets.map(({ turns, ...bucket }) => ({ ...bucket, turns: Float64Array.from(turns) })) };
}

function compactSummary(source: Summary) {
  const { intervals, ...fields } = source;
  if (!intervals?.length) return { summary: source, bytes: 0 };
  const values = new Float64Array(intervals.length * 3);
  let index = 0;
  for (const { start, end, kind } of intervals) {
    values[index++] = start;
    values[index++] = end;
    values[index++] = kind === "tools" ? 1 : 0;
  }
  const summary: Summary = {
    ...fields,
    // Preserve the exact interval DTO for summaries returned through RPC.
    get intervals() {
      const rows: NonNullable<Summary["intervals"]> = new Array(values.length / 3);
      for (let i = 0; i < rows.length; i++) {
        const offset = i * 3;
        rows[i] = { start: values[offset], end: values[offset + 1], kind: values[offset + 2] ? "tools" : "model" };
      }
      return rows;
    },
  };
  return { summary, bytes: values.byteLength + 192 };
}

export function sessionShard(summary: Summary, requests: readonly LedgerRequest[], key: string, at: number, retry?: boolean): SessionShard {
  const grouped = compactRequests(requests);
  const retained = compactSummary(summary);
  const tallies = (list: readonly Tally[]) => list.reduce((bytes, row) => bytes + 72 + stringBytes(row.name), 0);
  let bytes = 1024 + stringBytes(key) + grouped.undated.byteLength + retained.bytes;
  for (const value of Object.values(summary.agent)) if (typeof value === "string") bytes += stringBytes(value);
  for (const day of grouped.days) bytes += 512 + stringBytes(day.day) + day.turns.byteLength;
  bytes += tallies(summary.tools) + tallies(summary.skills) + tallies(summary.programs);
  for (const day of summary.activity) bytes += 120 + tallies(day.tools) + tallies(day.skills) + tallies(day.programs);
  return { ...grouped, summary: retained.summary, key, at, retry, bytes };
}

export function aggregate(all: Summary[], requests: ReadonlyMap<string, LedgerRequest[]>, scope: Scope, offset: number, scanned: number, failed: number, now = Date.now()) {
  const grouped = new Map<string, RequestDays>();
  for (const [id, rows] of requests) grouped.set(id, compactRequests(rows));
  return overviewPage(aggregateScope(all, grouped, scope, scanned, failed, now), offset);
}

export function overviewPage(data: ReturnType<typeof aggregateScope>, offset: number) {
  return { ...data, sessions: data.sessions.slice(offset, offset + PAGE_SIZE) };
}

export function aggregateScope(all: Summary[], shards: ReadonlyMap<string, RequestDays>, scope: Scope, scanned: number, failed: number, now = Date.now()) {
  const today = dayKeyOf(now) ?? "";
  const day = startOfDayKey(scope.day) === null ? "" : scope.day;
  const from = day || (scope.range === "custom" ? scope.start : scope.range === "all" ? ""
    : shiftDayKey(today, -(scope.range === "today" ? 0 : scope.range === "7d" ? 6 : 29)) ?? "");
  const to = day || (scope.range === "custom" ? scope.end : "");
  const start = startOfDayKey(from) ?? 0;
  const end = startOfDayKey(shiftDayKey(to, 1) ?? "") ?? Infinity;
  const within = (at: number) => at >= start && at < end;
  const projectKey = (s: Summary) => s.agent.cwd || "__ungrouped__";
  const groups = [...new Set(all.map(projectKey))].sort();
  const query = scope.query.toLowerCase();
  const eligible = all.filter((s) => {
    const a = s.agent;
    const search = !query || `${a.title} ${a.cwd} ${a.provider} ${a.model}`.toLowerCase().includes(query);
    return search && (scope.coverage === "all" || (scope.coverage === "archived") === a.archived);
  });
  const inScope = eligible.filter((s) => {
    const shard = shards.get(s.agent.id);
    return shard?.days.some((bucket) => within(bucket.at)) || shard?.undated.some(within)
      || (!shard?.hasRequests && within(s.agent.updatedAt)) || s.activity.some((d) => within(d.time));
  });
  const pick = scope.pick;
  const matchesFilters = (s: Summary) => (!scope.group || projectKey(s) === scope.group)
    && (!pick || s.activity.some((d) => within(d.time) && d[pick].some((t) => t.name === scope.name)));
  const selected = inScope.filter(matchesFilters);
  const filtered = eligible.filter(matchesFilters);
  let tokens = 0, input = 0, cacheRead = 0, pairedInput = 0, pairedRead = 0, cost = 0, priced = 0, total = 0, turns = 0;
  const days = new Map<string, { day: string; tokens: number; costUsd: number | null; sessions: Set<string> }>();
  const parts = emptyParts();
  const rangeUsage = new Map<string, { tokens: number; complete: boolean }>();
  const tallySessionCounts = { tools: {} as Record<string, number>, skills: {} as Record<string, number>, programs: {} as Record<string, number> };
  const tally = (key: "tools" | "skills" | "programs") => {
    const map = new Map<string, Tally>();
    for (const s of selected) {
      const names = new Set<string>();
      for (const day of s.activity.filter((d) => within(d.time))) for (const t of day[key]) {
        names.add(t.name);
        const hit = map.get(t.name) ?? { name: t.name, count: 0, last: 0 };
        hit.count += t.count; hit.last = Math.max(hit.last, t.last); map.set(t.name, hit);
      }
      for (const name of names) tallySessionCounts[key][name] = (tallySessionCounts[key][name] ?? 0) + 1;
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  };
  for (const s of filtered) {
    const turnIds = new Set<number>();
    for (const bucket of shards.get(s.agent.id)?.days ?? []) {
      const { day } = bucket;
      const d = days.get(day) ?? { day, tokens: 0, costUsd: 0, sessions: new Set<string>() };
      d.tokens += bucket.tokens;
      d.sessions.add(s.agent.id);
      d.costUsd = d.costUsd === null || bucket.priced !== bucket.calls ? null : d.costUsd + bucket.cost;
      days.set(day, d);
      if (!within(bucket.at)) continue;
      if (bucket.measured) {
        const usage = rangeUsage.get(s.agent.id) ?? { tokens: 0, complete: true };
        usage.tokens += bucket.measuredTokens;
        usage.complete &&= bucket.measuredCostComplete;
        rangeUsage.set(s.agent.id, usage);
      }
      total += bucket.calls;
      for (const turn of bucket.turns) turnIds.add(turn);
      input += bucket.input;
      cacheRead += bucket.cacheRead;
      pairedInput += bucket.pairedInput;
      pairedRead += bucket.pairedRead;
      tokens += bucket.tokens;
      cost += bucket.cost;
      priced += bucket.priced;
      for (const key of categories) parts[key] += bucket.parts[key];
    }
    turns += turnIds.size;
  }
  const rangeTokens = (s: Summary) => rangeUsage.get(s.agent.id)?.tokens ?? 0;
  selected.sort((a, b) => scope.sort === "tokens" ? rangeTokens(b) - rangeTokens(a)
    : scope.sort === "context" ? (b.contextTokens ?? 0) - (a.contextTokens ?? 0) : b.agent.updatedAt - a.agent.updatedAt);
  const tools = tally("tools"), skills = tally("skills"), programs = tally("programs");
  const byProject = new Map<string, { key: string; sessions: number; tokens: number }>();
  for (const session of selected) {
    const key = projectKey(session);
    const project = byProject.get(key) ?? { key, sessions: 0, tokens: 0 };
    project.sessions++; project.tokens += rangeTokens(session);
    byProject.set(key, project);
  }
  const counts = new Map<string, number>();
  for (const session of inScope) {
    const key = projectKey(session);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groupCounts = groups.map((key) => ({ key, count: counts.get(key) ?? 0 }));
  const projects = [...byProject.values()].filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
  let wallMs = 0, toolsMs = 0;
  for (const s of selected) {
    const intervals = scopedIntervals(s.intervals ?? [], start, end);
    wallMs += unionMs(intervals);
    toolsMs += intervals.filter((row) => row.kind === "tools").reduce((n, row) => n + row.end - row.start, 0);
  }
  return { sessions: selected, total: selected.length, scopeTotal: inScope.length, scanned, failed,
    tokens, input, cacheRead, pairedInput, pairedRead, turns, calls: total, toolCalls: tools.reduce((n, t) => n + t.count, 0),
    wallMs, toolsMs, timing: sumTiming(selected), costUsd: priced ? cost : null,
    costComplete: total > 0 && priced === total, parts, groups,
    groupCounts, projects, window: { start, end: Number.isFinite(end) ? end - 1 : null, from: from || null, to: to || today || null },
    tallySessionCounts, sessionsArchived: all.filter((s) => s.agent.archived).length,
    archivedScoped: selected.filter((s) => s.agent.archived).length,
    costSessions: [...rangeUsage.values()].filter((usage) => usage.complete).length,
    usageSessions: rangeUsage.size,
    days: [...days.values()].map((d) => ({ ...d, sessions: d.sessions.size })).sort((a, b) => a.day.localeCompare(b.day)),
    tools, skills, programs };
}
