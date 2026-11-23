import { execFileSync } from "node:child_process";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { emptyParts, emptyUsage, scopeSchema, type Scope, type Summary, type Tally } from "../shared/contracts";
import { dayKeyOf, shiftDayKey, startOfDayKey } from "../shared/core/days";
import { usageSourceOf } from "../shared/usage";
import { aggregateScope, overviewPage, sessionShard } from "../server/corpus";
import { ContextFold } from "../server/fold";
import { scopedIntervals, sumTiming, unionMs } from "../server/timing";

type LedgerRequest = Parameters<typeof sessionShard>[1][number];
const now = new Date(2026, 10, 23, 12).getTime();
const today = dayKeyOf(now)!;
const midnight = (offset: number) => startOfDayKey(shiftDayKey(today, offset)!)!;
const part = { ...emptyParts(), user: 1, assistant: 2, system: 4 };
const row = (time: number, turn: number, extra?: Partial<LedgerRequest>): LedgerRequest => ({
  time, turn, parts: part, usage: { ...emptyUsage(), input: 101, cacheRead: 31, output: 22, reasoning: 5 }, costUsd: 0.021, ...extra,
});

function fixture() {
  const summaries: Summary[] = [], requests = new Map<string, LedgerRequest[]>();
  const fold = new ContextFold("codex");
  for (let index = 0; index < 32; index++) {
    const id = `agent-${index}`;
    const summary = fold.summary({ id, title: `Project ${index % 2} session ${index}`, model: "model", cwd: index % 3 ? "/demo" : "",
      provider: index % 3 ? "codex" : "antigravity", archived: index % 2 === 0, running: false, workspaceId: null, parentId: null,
      sessionId: id, createdAt: midnight(-60), updatedAt: index === 1 ? midnight(-41) : now - index });
    if (index === 1 || index >= 7) {
      for (const day of [midnight(-35), midnight(-1), midnight(0)]) summary.activity.push({ time: day,
        tools: [{ name: "read_file", count: 2, last: day + 12 }], skills: [{ name: "review", count: 1, last: day + 36 }],
        programs: [{ name: "git", count: 3, last: day + 81 }] });
      summary.intervals = [{ start: midnight(0) - 50, end: midnight(0) + 100, kind: "model" },
        { start: midnight(0) - 20, end: midnight(0) + 85, kind: "tools" },
        { start: midnight(0) + 30, end: midnight(0) + 150, kind: "tools" }];
      summary.wallMs = 200;
      summary.modelMs = 150;
      summary.toolMs = 225;
      summary.contextTokens = index * 100;
    }
    summaries.push(summary);
    if (index <= 1) continue;
    if (index === 2) requests.set(id, [row(0, 1)]);
    else if (index === 3) requests.set(id, [row(NaN, 1), row(Infinity, 1), row(-Infinity, 2)]);
    else if (index === 4) requests.set(id, [row(new Date(1969, 11, 31, 12).getTime(), 1), row(1, 1)]);
    else if (index === 5) requests.set(id, [row(8.64e15 + 1000, 1)]);
    else if (index === 6) requests.set(id, [row(midnight(-1), 1), row(midnight(-1), 1, { usageAt: midnight(0) }),
      row(midnight(0), 1, { usageSources: {}, costUsd: null }), row(midnight(0), 2, { usageAt: midnight(1) })]);
    else requests.set(id, Array.from({ length: 110 }, (_, i) => {
      const day = (i * 29 + index * 13) % 51 - 42;
      return row(midnight(day) - 1, i % 17, {
        usageAt: midnight(day), costUsd: i % 7 === 0 ? null : i % 5 / 100,
        usage: { input: 120 + (i % 7), cacheRead: i % 2 * 31, cacheWrite: i % 5, output: 15 + index, reasoning: i % 17 },
        parts: i % 7 === 0 ? emptyParts() : { ...part, user: i % 12, reasoning: index, assistant: i % 5 },
        usageFields: i % 4 === 0 ? ["output"] : undefined,
        usageSources: i % 6 === 0 ? { input: "cumulative", cacheRead: "reported" } : i % 9 === 0 ? {} : undefined,
      });
    }));
  }
  const shards = new Map(summaries.map((summary) => [summary.agent.id,
    sessionShard(summary, requests.get(summary.agent.id) ?? [], summary.agent.id, now)]));
  return { summaries, requests, shards };
}

function expectEquivalent(actual: ReturnType<typeof overviewPage>, expected: ReturnType<typeof overviewPage>) {
  const { parts, costUsd, days, ...exact } = actual;
  const { parts: oldParts, costUsd: oldCost, days: oldDays, ...oldExact } = expected;
  const cost = (value: number | null, old: number | null) => {
    if (old === null) expect(value).toBeNull();
    else expect(value).toBeCloseTo(old, 8);
  };
  expect(exact).toEqual(oldExact);
  cost(costUsd, oldCost);
  for (const key of Object.keys(parts) as (keyof typeof parts)[]) expect(parts[key]).toBeCloseTo(oldParts[key], 8);
  expect(days.map(({ costUsd: _cost, ...day }) => day)).toEqual(oldDays.map(({ costUsd: _cost, ...day }) => day));
  for (const [index, day] of days.entries()) cost(day.costUsd, oldDays[index].costUsd);
}

test.each(["today", "7d", "30d", "custom", "all"] as const)("matches the previous per-request Overview for range %s", (range) => {
  const { summaries, requests, shards } = fixture();
  const compact = [...shards.values()].map(({ summary }) => summary);
  const filters: Partial<Scope>[] = [{}, { day: today }, { day: shiftDayKey(today, -1)! }, { day: "2026-02-30" },
    { coverage: "archived", sort: "tokens" }, { coverage: "active", sort: "context", query: "ANTIGRAVITY" },
    { group: "/demo", pick: "tools", name: "read_file" }, { pick: "skills", name: "review" }, { pick: "programs", name: "git" },
    { pick: "tools", name: "not-used" }, { range: "custom", start: "1969-12-31", end: "1970-01-02" },
    { range: "custom", start: "", end: today }, { range: "custom", start: today, end: shiftDayKey(today, -2)! } ];
  for (const filter of filters) {
    const scope = scopeSchema.parse({ range, start: shiftDayKey(today, -18), end: shiftDayKey(today, -2), ...filter });
    const actual = aggregateScope(compact, shards, scope, 34, 2, now);
    const expected = aggregatePerRequest(summaries, (id) => requests.get(id), scope, 34, 2, now);
    for (const offset of [0, 24]) expectEquivalent(overviewPage(actual, offset), { ...expected, sessions: expected.sessions.slice(offset, offset + 24) });
  }
});

test("distinguishes request-day labels from windows when the local clock crosses midnight twice", () => {
  // Newfoundland rolled back at 00:01, so some Oct 31 requests were made
  // after the timestamp marking the start of the Nov 1 window.
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { aggregate } from "./server/service.ts";
    import { emptyParts, emptyUsage, scopeSchema } from "./shared/contracts.ts";
    import { ContextFold } from "./server/fold.ts";
    const s = new ContextFold("codex").summary({ id: "fixture", cwd: "/demo", title: "Fixture", provider: "codex", model: "" });
    const row = (utc, input) => ({ time: Date.parse(utc), turn: 4, parts: emptyParts(), usage: { ...emptyUsage(), input }, costUsd: 0 });
    const requests = new Map([[s.agent.id, [row("2009-11-01T02:29:59Z", 100), row("2009-11-01T02:30:00Z", 200),
      row("2009-11-01T02:31:10Z", 400), row("2009-11-01T03:30:00Z", 800)]]]);
    const result = (day) => aggregate([s], requests, scopeSchema.parse({ range: "all", day }), 0, 1, 0);
    assert.equal(result("2009-10-31").tokens, 100);
    assert.equal(result("2009-11-01").tokens, 1400);
    assert.equal(result("").turns, 1);
    assert.deepEqual(result("2009-11-01").days.map(({ day, tokens }) => [day, tokens]), [["2009-10-31", 500], ["2009-11-01", 1000]]);
  `], { cwd: new URL("..", import.meta.url), timeout: 10_000, env: { ...process.env, TZ: "America/St_Johns" } });
});

// Reference implementation from before daily compaction.
const accountingTime = (request: LedgerRequest) => request.usageAt ?? request.time;
function aggregatePerRequest(all: Summary[], requests: (id: string) => LedgerRequest[] | undefined, scope: Scope, scanned: number, failed: number, now = Date.now()) {
  const today = dayKeyOf(now) ?? "";
  const day = startOfDayKey(scope.day) === null ? "" : scope.day;
  const from = day || (scope.range === "custom" ? scope.start : scope.range === "all" ? ""
    : shiftDayKey(today, -(scope.range === "today" ? 0 : scope.range === "7d" ? 6 : 29)) ?? "");
  const to = day || (scope.range === "custom" ? scope.end : "");
  const start = startOfDayKey(from) ?? 0;
  const end = startOfDayKey(shiftDayKey(to, 1) ?? "") ?? Infinity;
  const projectKey = (s: Summary) => s.agent.cwd || "__ungrouped__";
  const groups = [...new Set(all.map(projectKey))].sort();
  const query = scope.query.toLowerCase();
  const eligible = all.filter((s) => {
    const a = s.agent;
    const search = !query || `${a.title} ${a.cwd} ${a.provider} ${a.model}`.toLowerCase().includes(query);
    return search && (scope.coverage === "all" || (scope.coverage === "archived") === a.archived);
  });
  const inScope = eligible.filter((s) => {
    const rows = requests(s.agent.id) ?? [];
    return rows.some((r) => accountingTime(r) >= start && accountingTime(r) < end)
      || (!rows.length && s.agent.updatedAt >= start && s.agent.updatedAt < end)
      || s.activity.some((d) => d.time >= start && d.time < end);
  });
  const matchesPick = (s: Summary) => !scope.pick || s.activity.some((d) => d.time >= start && d.time < end
    && d[scope.pick as "tools" | "skills" | "programs"].some((t) => t.name === scope.name));
  const matchesFilters = (s: Summary) => (!scope.group || projectKey(s) === scope.group) && matchesPick(s);
  const selected = inScope.filter(matchesFilters);
  const filtered = eligible.filter(matchesFilters);
  let tokens = 0, input = 0, cacheRead = 0, pairedInput = 0, pairedRead = 0, cost = 0, priced = 0, total = 0, turns = 0;
  const days = new Map<string, { day: string; tokens: number; costUsd: number | null; sessions: Set<string> }>();
  const parts = emptyParts();
  const partKeys = Object.keys(parts) as Array<keyof typeof parts>;
  const rangeUsage = new Map<string, { tokens: number; complete: boolean }>();
  const tallySessionCounts = { tools: {} as Record<string, number>, skills: {} as Record<string, number>, programs: {} as Record<string, number> };
  const tally = (key: "tools" | "skills" | "programs") => {
    const map = new Map<string, Tally>();
    for (const s of selected) {
      const names = new Set<string>();
      for (const day of s.activity.filter((d) => d.time >= start && d.time < end)) for (const t of day[key]) {
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
    for (const r of requests(s.agent.id) ?? []) {
      const at = accountingTime(r), day = at > 0 ? dayKeyOf(at) : null;
      if (day === null) continue;
      const hasInput = usageSourceOf(r, "input"), hasOutput = usageSourceOf(r, "output"), hasRead = usageSourceOf(r, "cacheRead");
      const measured = hasInput || hasOutput || hasRead || usageSourceOf(r, "cacheWrite") || usageSourceOf(r, "reasoning");
      const d = days.get(day) ?? { day, tokens: 0, costUsd: 0, sessions: new Set<string>() };
      d.tokens += r.usage.input + r.usage.output; d.sessions.add(s.agent.id);
      d.costUsd = d.costUsd === null || r.costUsd === null ? null : d.costUsd + r.costUsd;
      days.set(day, d);
      if (at < start || at >= end) continue;
      if (measured) {
        const usage = rangeUsage.get(s.agent.id) ?? { tokens: 0, complete: true };
        usage.tokens += r.usage.input + r.usage.output;
        usage.complete &&= r.costUsd !== null;
        rangeUsage.set(s.agent.id, usage);
      }
      total++; turnIds.add(r.turn); input += r.usage.input; cacheRead += r.usage.cacheRead;
      if (hasInput && hasRead) { pairedInput += r.usage.input; pairedRead += r.usage.cacheRead; }
      tokens += r.usage.input + r.usage.output;
      if (r.costUsd !== null) { cost += r.costUsd; priced++; }
      const sum = Object.values(r.parts).reduce((a, b) => a + b, 0);
      for (const key of partKeys) parts[key] += sum ? r.parts[key] / sum * r.usage.input : 0;
      parts.assistant += Math.max(0, r.usage.output - r.usage.reasoning); parts.reasoning += r.usage.reasoning;
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
