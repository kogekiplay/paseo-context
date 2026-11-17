import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { stat } from "node:fs/promises";
import { emptyParts, type Agent, type Scope, type Summary, type Tally } from "../shared/contracts";
import { ContextFold } from "./fold";
import { SessionReader } from "./reader";
import { Pricing } from "./pricing";
import { count, printable, record, text, timestamp } from "./value";
import { createHash } from "node:crypto";
import { messagesOf } from "./normalize";
import { scopedIntervals, sumTiming, unionMs } from "./timing";

export function agentOf(a: PaseoAgent): Agent {
  return { id: a.id, workspaceId: a.workspaceId ?? null, parentId: a.labels["paseo.parent-agent-id"] ?? null,
    title: a.title || a.id, cwd: a.cwd, provider: a.provider, model: a.runtimeInfo?.model ?? a.model ?? "",
    sessionId: a.persistence?.nativeHandle ?? a.persistence?.sessionId ?? a.runtimeInfo?.sessionId ?? null,
    createdAt: timestamp(a.createdAt), updatedAt: timestamp(a.updatedAt),
    archived: !!a.archivedAt, running: a.status === "running" || a.status === "initializing" };
}
export async function listAgents(paseo: PaseoApi) {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await paseo.agents.list({ filter: { includeArchived: true, includeBackground: true },
      includeBackground: true, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    agents.push(...page.entries.map((e) => e.agent));
    cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
    if (cursor && seen.has(cursor)) throw new Error("Agent directory returned a repeated cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...new Map(agents.map((a) => [a.id, a])).values()];
}
export class ContextService {
  constructor(readonly reader = new SessionReader()) {}
  readonly pricing = new Pricing();
  private summaries = new Map<string, { at: number; key: string; summary: Summary; requests: ContextFold["requests"] }>();
  private corpus: { at: number; all: Summary[]; requests: Map<string, ContextFold["requests"]>; scanned: number; failed: number } | null = null;
  private corpusBusy: Promise<NonNullable<ContextService["corpus"]>> | null = null;
  private closed = false;
  private nativeMembers = new Map<string, PaseoAgent>();
  private revisions = new Map<string, { fingerprint: string; revision: number }>();
  private serial = 0;
  async agent(id: string, paseo: PaseoApi) {
    const native = this.nativeMembers.get(id);
    if (native) return native;
    const result = await paseo.agents.ref(id).refresh();
    if (!result) throw new Error("Agent is no longer available");
    return result.agent;
  }
  private async timeline(agent: Agent, paseo: PaseoApi, targetNodeId?: number) {
    const pages: Array<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>> = [];
    let cursor;
    let epoch: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await paseo.agents.ref(agent.id).timeline.refetch({ direction: cursor ? "before" : "tail", limit: 200, ...(cursor ? { cursor } : {}) });
      if (page.error) throw new Error(page.error);
      if (epoch !== undefined && page.epoch !== epoch) throw new Error("Timeline changed while reading history");
      epoch = page.epoch;
      pages.push(page);
      cursor = page.hasOlder ? page.startCursor ?? undefined : undefined;
      const key = JSON.stringify(cursor);
      if (cursor && seen.has(key)) throw new Error("Timeline returned a repeated cursor");
      if (cursor) seen.add(key);
    } while (cursor);
    const fold = new ContextFold("timeline", epoch ?? "timeline");
    let line = 0, content = "";
    for (const page of pages.reverse()) for (const entry of page.entries) {
      const item = record(entry.item);
      const row = { ...item, timestamp: entry.timestamp };
      fold.apply(row);
      line++;
      const node = targetNodeId === undefined ? null : fold.nodes[targetNodeId];
      if (node?.line === line) content = messagesOf(row, "timeline").find((m) => m.block === node.block && m.category === node.category)?.text ?? "";
    }
    return { fold, content };
  }
  async load(raw: PaseoAgent, paseo: PaseoApi) {
    const agent = agentOf(raw);
    const native = await this.reader.read(agent);
    const fold = native?.entry.fold ?? (await this.timeline(agent, paseo)).fold;
    for (const child of fold.collaboration.children.values()) {
      const id = `native:${raw.provider}:${child.sessionId}`;
      if (this.nativeMembers.size >= 512) this.nativeMembers.delete(this.nativeMembers.keys().next().value!);
      this.nativeMembers.set(id, { ...raw, id, title: child.title, status: "idle",
        createdAt: new Date(child.time).toISOString(), updatedAt: raw.updatedAt, lastUsage: undefined,
        labels: { ...raw.labels, "paseo.parent-agent-id": raw.id },
        persistence: { provider: raw.provider, sessionId: child.sessionId, nativeHandle: child.sessionId } });
    }
    const summary = fold.summary(agent, native ? "native" : "timeline");
    const last = raw.lastUsage;
    if (last?.contextWindowMaxTokens !== undefined) summary.contextWindow = last.contextWindowMaxTokens;
    if (last?.contextWindowUsedTokens !== undefined) summary.contextTokens = last.contextWindowUsedTokens;
    if (!native) summary.notices.push("usage-unavailable");
    const requests = this.pricing.priceRequests(agent.provider, fold.requests);
    const complete = requests.every((r) => r.costUsd !== null);
    summary.costUsd = requests.length && complete ? requests.reduce((n, r) => n + r.costUsd!, 0) : null;
    summary.costComplete = !!requests.length && complete;
    if (last?.totalCostUsd !== undefined && native === null) {
      summary.costUsd = last.totalCostUsd;
      summary.notices.push("last-turn-cost");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify([summary, fold.revision, fold.nodes, fold.events, fold.commands, requests])).digest("hex");
    const previous = this.revisions.get(agent.id);
    const revision = previous?.fingerprint === fingerprint ? previous.revision : ++this.serial;
    if (!this.closed) {
      this.revisions.delete(agent.id); this.revisions.set(agent.id, { fingerprint, revision });
      if (this.revisions.size > 512) this.revisions.delete(this.revisions.keys().next().value!);
    }
    return { agent, fold, summary, requests, revision };
  }
  async snapshot(id: string, paseo: PaseoApi) {
    await this.pricing.refresh();
    const data = await this.load(await this.agent(id, paseo), paseo);
    return { summary: data.summary, requests: data.requests, events: data.fold.events };
  }
  async content(id: string, nodeId: number, paseo: PaseoApi) {
    const agent = agentOf(await this.agent(id, paseo));
    if (await this.reader.locate(agent)) return this.reader.content(agent, nodeId);
    const data = await this.timeline(agent, paseo, nodeId);
    const node = data.fold.nodes[nodeId];
    if (!node) throw new Error("Context item is no longer available");
    return data.content;
  }
  async summary(raw: PaseoAgent, paseo: PaseoApi) {
    return (await this.ledger(raw, paseo)).summary;
  }
  private async ledger(raw: PaseoAgent, paseo: PaseoApi) {
    const path = await this.reader.locate(agentOf(raw));
    const source = path ? await stat(path) : null;
    const key = JSON.stringify([raw.updatedAt, raw.status, raw.lastUsage, raw.title, raw.labels, raw.archivedAt,
      source?.ino, source?.size, source?.mtimeMs, this.pricing.revision]);
    const cached = this.summaries.get(raw.id);
    if (cached?.key === key && Date.now() - cached.at < (path ? 600_000 : 15_000)) return cached;
    const data = await this.load(raw, paseo);
    const value = { at: Date.now(), key, summary: data.summary,
      requests: data.requests.map((r) => ({ ...r, prompt: "", response: "" })) };
    if (!this.closed) {
      this.summaries.delete(raw.id); this.summaries.set(raw.id, value);
      let weight = [...this.summaries.values()].reduce((n, v) => n + v.requests.length, 0);
      for (const [id, old] of this.summaries) {
        if (id !== raw.id && (this.summaries.size > 256 || weight > 50000 || Date.now() - old.at > 600_000)) {
          this.summaries.delete(id); weight -= old.requests.length;
        }
      }
    }
    return value;
  }
  async overview(scope: Scope, offset: number, paseo: PaseoApi) {
    await this.pricing.refresh();
    const corpus = await this.readCorpus(paseo);
    return aggregate(corpus.all, corpus.requests, scope, offset, corpus.scanned, corpus.failed);
  }
  async backfill(paseo: PaseoApi) {
    this.corpus = null;
    const corpus = await this.readCorpus(paseo);
    return { complete: corpus.failed === 0, remaining: 0, failed: corpus.failed, running: false,
      total: corpus.scanned, covered: corpus.scanned - corpus.failed, unsupported: 0 };
  }
  private async readCorpus(paseo: PaseoApi) {
    if (this.corpus && Date.now() - this.corpus.at < 10_000) return this.corpus;
    if (this.corpusBusy) return this.corpusBusy;
    this.corpusBusy = this.scanCorpus(paseo);
    try { return await this.corpusBusy; } finally { this.corpusBusy = null; }
  }
  private async scanCorpus(paseo: PaseoApi) {
    const agents = await listAgents(paseo);
    const all: Summary[] = [];
    const allRequests = new Map<string, Awaited<ReturnType<ContextService["load"]>>["requests"]>();
    let failed = 0;
    for (let i = 0; i < agents.length; i += 4) {
      if (this.closed) throw new Error("Plugin was stopped");
      const batch = await Promise.allSettled(agents.slice(i, i + 4).map(async (agent) => {
        const data = await this.ledger(agent, paseo);
        allRequests.set(agent.id, data.requests);
        return data.summary;
      }));
      for (const r of batch) if (r.status === "fulfilled") all.push(r.value); else failed++;
    }
    const corpus = { at: Date.now(), all, requests: allRequests, scanned: agents.length, failed };
    if (!this.closed) this.corpus = corpus;
    return corpus;
  }
  async fleet(id: string, paseo: PaseoApi) {
    const agents = await listAgents(paseo);
    const map = new Map([...agents, ...this.nativeMembers.values()].map((a) => [a.id, a]));
    if (!map.has(id)) throw new Error("Agent is no longer available");
    let root = map.get(id)!;
    const visited = new Set<string>();
    while (root.labels["paseo.parent-agent-id"] && map.has(root.labels["paseo.parent-agent-id"]) && !visited.has(root.id)) {
      visited.add(root.id); root = map.get(root.labels["paseo.parent-agent-id"])!;
    }
    const ids = new Set([root.id]);
    for (let pass = 0; pass < agents.length; pass++) {
      const before = ids.size;
      for (const a of agents) if (a.labels["paseo.parent-agent-id"] && ids.has(a.labels["paseo.parent-agent-id"])) ids.add(a.id);
      if (before === ids.size) break;
    }
    await this.pricing.refresh();
    const members: Summary[] = [];
    let failed = 0;
    const visitedSessions = new Set<string>();
    const queue = agents.filter((a) => ids.has(a.id));
    if (!queue.length) queue.push(root);
    while (queue.length) {
      const a = queue.shift()!, key = `${a.provider}:${agentOf(a).sessionId ?? a.id}`;
      if (visitedSessions.has(key)) continue;
      visitedSessions.add(key);
      try { members.push(await this.summary(a, paseo)); } catch { failed++; }
      for (const child of this.nativeMembers.values()) if (child.labels["paseo.parent-agent-id"] === a.id) queue.push(child);
    }
    return { rootId: root.id, members, failed };
  }
  async collaboration(id: string, paseo: PaseoApi) {
    const family = await this.fleet(id, paseo), records = [];
    let failed = family.failed;
    for (const member of family.members) {
      try {
        const data = await this.load(await this.agent(member.agent.id, paseo), paseo);
        records.push(...data.fold.collaboration.records.map((r) => ({ ...r, agentId: member.agent.id,
          to: family.members.find((m) => m.agent.sessionId === r.to || m.agent.id === r.to)?.agent.id ?? r.to })));
      } catch { failed++; }
    }
    return { records: records.sort((a, b) => a.time - b.time), failed };
  }
  clear() { this.closed = true; this.reader.clear(); this.pricing.clear(); this.summaries.clear(); this.nativeMembers.clear(); this.revisions.clear(); this.corpus = null; }
}

export function aggregate(all: Summary[], requests: Map<string, ContextFold["requests"]>, scope: Scope, offset: number, scanned: number, failed: number, now = Date.now()) {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const shiftDay = (value: number, n: number) => { const date = new Date(value); date.setDate(date.getDate() + n); return date.getTime(); };
  const start = scope.day ? timestamp(`${scope.day}T00:00:00`) : scope.range === "all" ? 0
    : scope.range === "custom" ? timestamp(`${scope.start}T00:00:00`)
    : shiftDay(midnight.getTime(), -(scope.range === "today" ? 0 : scope.range === "7d" ? 6 : 29));
  const end = scope.day ? shiftDay(timestamp(`${scope.day}T00:00:00`), 1)
    : scope.range === "custom" && scope.end ? shiftDay(timestamp(`${scope.end}T00:00:00`), 1) : Infinity;
  const groups = [...new Set(all.map((s) => s.agent.cwd))].sort();
  const filtered = all.filter((s) => {
    const a = s.agent, rows = requests.get(a.id) ?? [];
    const active = rows.some((r) => r.time >= start && r.time < end) || (!rows.length && a.updatedAt >= start && a.updatedAt < end);
    const search = `${a.title} ${a.cwd} ${a.provider} ${a.model}`.toLowerCase().includes(scope.query.toLowerCase());
    return search && (!scope.group || a.cwd === scope.group)
      && (scope.coverage === "all" || (scope.coverage === "archived") === a.archived)
      && (!scope.pick || s.activity.some((d) => d.time >= start && d.time < end && d[scope.pick as "tools" | "skills" | "programs"].some((t) => t.name === scope.name)));
  });
  const selected = filtered.filter((s) => {
    const rows = requests.get(s.agent.id) ?? [];
    return rows.some((r) => r.time >= start && r.time < end)
      || (!rows.length && s.agent.updatedAt >= start && s.agent.updatedAt < end)
      || s.activity.some((d) => d.time >= start && d.time < end);
  });
  let tokens = 0, input = 0, cacheRead = 0, cost = 0, priced = 0, total = 0, turns = 0;
  const days = new Map<string, { day: string; tokens: number; costUsd: number | null; sessions: Set<string> }>();
  const parts = emptyParts();
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
    for (const r of requests.get(s.agent.id) ?? []) {
      const date = new Date(r.time);
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const d = days.get(day) ?? { day, tokens: 0, costUsd: 0, sessions: new Set<string>() };
      d.tokens += r.usage.input + r.usage.output; d.sessions.add(s.agent.id);
      d.costUsd = d.costUsd === null || r.costUsd === null ? null : d.costUsd + r.costUsd;
      days.set(day, d);
      if (r.time < start || r.time >= end) continue;
      total++; turnIds.add(r.turn); input += r.usage.input; cacheRead += r.usage.cacheRead;
      tokens += r.usage.input + r.usage.output;
      if (r.costUsd !== null) { cost += r.costUsd; priced++; }
      const sum = Object.values(r.parts).reduce((a, b) => a + b, 0);
      for (const key of Object.keys(parts) as Array<keyof typeof parts>) parts[key] += sum ? r.parts[key] / sum * r.usage.input : 0;
      parts.assistant += Math.max(0, r.usage.output - r.usage.reasoning); parts.reasoning += r.usage.reasoning;
    }
    turns += turnIds.size;
  }
  const inRange = (s: Summary) => (requests.get(s.agent.id) ?? []).filter((r) => r.time >= start && r.time < end);
  const rangeTokens = (s: Summary) => inRange(s).reduce((n, r) => n + r.usage.input + r.usage.output, 0);
  selected.sort((a, b) => scope.sort === "tokens" ? rangeTokens(b) - rangeTokens(a)
    : scope.sort === "context" ? (b.contextTokens ?? 0) - (a.contextTokens ?? 0) : b.agent.updatedAt - a.agent.updatedAt);
  const tools = tally("tools"), skills = tally("skills"), programs = tally("programs");
  const groupCounts = groups.map((key) => ({ key, count: selected.filter((s) => s.agent.cwd === key).length }));
  let wallMs = 0, toolsMs = 0;
  for (const s of selected) {
    const intervals = scopedIntervals(s.intervals ?? [], start, end);
    wallMs += unionMs(intervals);
    toolsMs += intervals.filter((row) => row.kind === "tools").reduce((n, row) => n + row.end - row.start, 0);
  }
  return { sessions: selected.slice(offset, offset + 24), total: selected.length, scanned, failed,
    tokens, input, cacheRead, turns, calls: total, toolCalls: tools.reduce((n, t) => n + t.count, 0),
    wallMs, toolsMs, timing: sumTiming(selected), costUsd: priced ? cost : null,
    costComplete: total > 0 && priced === total, parts, groups,
    groupCounts, tallySessionCounts, sessionsArchived: all.filter((s) => s.agent.archived).length,
    archivedScoped: selected.filter((s) => s.agent.archived).length,
    costSessions: selected.filter((s) => { const rows = inRange(s); return rows.length > 0 && rows.every((r) => r.costUsd !== null); }).length,
    usageSessions: selected.filter((s) => inRange(s).length > 0).length,
    days: [...days.values()].map((d) => ({ ...d, sessions: d.sessions.size })).sort((a, b) => a.day.localeCompare(b.day)),
    tools, skills, programs };
}
