import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { stat } from "node:fs/promises";
import { emptyParts, type Agent, type Request, type Scope, type Summary, type Tally } from "../shared/contracts";
import { ContextFold } from "./fold";
import { SessionReader, type ReadBodies } from "./reader";
import { Pricing } from "./pricing";
import { timestamp } from "./value";
import { createHash } from "node:crypto";
import { scopedIntervals, sumTiming, unionMs } from "./timing";
import { dayKeyOf, shiftDayKey, startOfDayKey } from "../shared/core/days";
import { usageSourceOf } from "../shared/usage";
import { ensureActive, nextCursor } from "./paging";
import { TimelineReader } from "./timeline";
import type { NativeLocation } from "./native-paths";
import type { NativeChild } from "./collaboration";
import { antigravityConversationId } from "./antigravity-log";

const CORPUS_TTL_MS = 10_000;
const FIRST_PAINT_BUDGET_MS = 400;
const SCAN_CONCURRENCY = 4;
const DERIVED_BYTES = 48 * 1024 * 1024;
type LedgerRequest = Pick<Request, "time" | "usageAt" | "turn" | "usage" | "usageFields" | "usageSources" | "parts" | "costUsd">;
interface Ledger { at: number; key: string; summary: Summary; requests: LedgerRequest[]; retry?: boolean }
interface Reader {
  read(agent: Agent, location?: NativeLocation | null): Promise<{
    entry: { fold: ContextFold }; bodies?: ReadBodies; residentBytes?: number; metadataOnly?: boolean; companionFailed?: boolean;
  } | null>;
  locate(agent: Agent): Promise<string | null>;
  locateSource?(agent: Agent): Promise<NativeLocation | null>;
  locateForScan?(agents: readonly Agent[]): Promise<(agent: Agent) => Promise<NativeLocation | null>>;
  content(agent: Agent, nodeId: number): Promise<string>;
  clear(): void;
}
export interface LoadedSession {
  agent: Agent;
  fold: ContextFold;
  summary: Summary;
  requests: Request[];
  revision: number;
  foldRevision?: number;
  bodies?: ReadBodies;
  residentBytes?: number;
  companionFailed?: boolean;
}
const PARENT = "paseo.parent-agent-id";
const nativeId = (provider: string, sessionId: string) => `native:${provider}:${sessionId}`;
const identityOf = (raw: PaseoAgent) => {
  const sessionId = agentOf(raw).sessionId;
  return JSON.stringify([raw.provider, sessionId === null ? "agent" : "session", sessionId ?? raw.id]);
};
interface FleetData {
  rootId: string;
  agents: Agent[];
  aliases: ReadonlyMap<string, string>;
  members: Summary[];
  loaded: Map<string, LoadedSession>;
  failed: number;
}
interface Corpus {
  at: number;
  pricingRevision: number;
  all: Summary[];
  requests: Map<string, LedgerRequest[]>;
  ledgers: Map<string, Ledger>;
  scanned: number;
  failed: number;
  unreadable: number;
  failedSessions: { id: string; reason: string }[];
  unreadableSessions: { id: string; reason: string }[];
  running: boolean;
  revision: number;
}

export function agentOf(a: PaseoAgent): Agent {
  const handle = a.persistence?.nativeHandle ?? a.persistence?.sessionId ?? a.runtimeInfo?.sessionId ?? null;
  return { id: a.id, workspaceId: a.workspaceId ?? null, parentId: a.labels[PARENT] ?? null,
    title: a.title || a.id, cwd: a.cwd, provider: a.provider, model: a.runtimeInfo?.model ?? a.model ?? "",
    sessionId: a.provider === "antigravity" ? antigravityConversationId(handle) ?? handle : handle,
    createdAt: timestamp(a.createdAt), updatedAt: timestamp(a.updatedAt),
    archived: !!a.archivedAt, running: a.status === "running" || a.status === "initializing" };
}
export async function listAgents(paseo: PaseoApi, signal?: AbortSignal) {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    ensureActive(signal);
    const page = await paseo.agents.list({ filter: { includeArchived: true, includeBackground: true },
      includeBackground: true, signal, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    ensureActive(signal);
    for (const entry of page.entries) agents.push(entry.agent);
    cursor = nextCursor(page.pageInfo.hasMore, page.pageInfo.nextCursor, seen, "Agent directory");
  } while (cursor);
  return [...new Map(agents.map((a) => [a.id, a])).values()];
}
export class ContextService {
  constructor(readonly reader: Reader = new SessionReader(), readonly pricing = new Pricing()) {}
  private summaries = new Map<string, Ledger>();
  private corpus: Corpus | null = null;
  private scanning: Corpus | null = null;
  private corpusBusy: Promise<Corpus> | null = null;
  private corpusRevision = 0;
  private lifetime = new AbortController();
  private timeline = new TimelineReader(this.lifetime.signal);
  private retryCorpusAt = 0;
  private refreshIssues: Corpus["failedSessions"] = [];
  private overviewCache = new Map<string, ReturnType<typeof aggregate>>();
  private overviewCacheRevision = "";
  private get closed() { return this.lifetime.signal.aborted; }
  private nativeMembers = new Map<string, PaseoAgent>();
  private revisions = new Map<string, { fingerprint: string; revision: number }>();
  private serial = 0;
  private derived = new Map<string, { fold: ContextFold; foldRevision: number; key: string; at: number; bytes: number; data: LoadedSession }>();
  private loading = new Map<string, Promise<LoadedSession>>();
  async directory(paseo: PaseoApi) {
    const agents = await listAgents(paseo, this.lifetime.signal);
    const sessions = new Set(agents.map((raw) => `${raw.provider}:${agentOf(raw).sessionId}`));
    return [...agents, ...[...this.nativeMembers.values()].filter((raw) => !sessions.has(`${raw.provider}:${agentOf(raw).sessionId}`))];
  }
  async agent(id: string, paseo: PaseoApi) {
    ensureActive(this.lifetime.signal);
    const native = this.nativeMembers.get(id);
    if (native) return native;
    const result = await paseo.agents.ref(id).refresh();
    ensureActive(this.lifetime.signal);
    if (!result) throw new Error("Agent is no longer available");
    return result.agent;
  }
  async load(raw: PaseoAgent, paseo: PaseoApi, location?: NativeLocation | null): Promise<LoadedSession> {
    // Simultaneous surfaces share a read. Different agent metadata must never
    // inherit an in-flight result from an older snapshot.
    const key = JSON.stringify([agentOf(raw), raw.lastUsage, this.pricing.revision]);
    const busy = this.loading.get(key);
    if (busy) return busy;
    const pending = this.loadSession(raw, paseo, key, location);
    this.loading.set(key, pending);
    try { return await pending; } finally { if (this.loading.get(key) === pending) this.loading.delete(key); }
  }
  private async loadSession(raw: PaseoAgent, paseo: PaseoApi, key: string, location?: NativeLocation | null): Promise<LoadedSession> {
    ensureActive(this.lifetime.signal);
    const agent = agentOf(raw);
    const native = await this.reader.read(agent, location);
    const timeline = native ? null : await this.timeline.read(agent.id, paseo);
    const fold = native?.entry.fold ?? timeline!.fold;
    ensureActive(this.lifetime.signal);
    const cached = this.derived.get(agent.id);
    if (cached?.fold === fold && cached.foldRevision === fold.revision && cached.key === key
      && cached.data.companionFailed === native?.companionFailed) {
      cached.at = Date.now();
      this.derived.delete(agent.id);
      this.derived.set(agent.id, cached);
      return cached.data;
    }
    for (const child of fold.collaboration.children.values()) this.rememberChild(raw, child);
    const summary = fold.summary(agent, native ? "native" : "timeline");
    const last = raw.lastUsage;
    if (last?.contextWindowMaxTokens !== undefined) summary.contextWindow = last.contextWindowMaxTokens;
    if (last?.contextWindowUsedTokens !== undefined && (agent.provider !== "antigravity" || summary.contextTokens === null)) {
      summary.contextTokens = last.contextWindowUsedTokens;
      summary.contextSource = "paseo";
    }
    if (!native) summary.notices.push("usage-unavailable");
    if (native?.metadataOnly) summary.notices.push("native-metadata-only");
    const requests = this.pricing.priceRequests(agent.provider, fold.requests);
    const complete = requests.every((r) => r.costUsd !== null);
    summary.costUsd = requests.length && complete ? requests.reduce((n, r) => n + r.costUsd!, 0) : null;
    summary.costComplete = !!requests.length && complete;
    if (last?.totalCostUsd !== undefined && native === null) {
      summary.costUsd = last.totalCostUsd;
      summary.notices.push("last-turn-cost");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(native
      ? [key, fold.epoch, fold.revision]
      : [key, summary, fold.revision, fold.epoch, fold.contentHashes, fold.statistics.rows, fold.nodes, fold.events, fold.commands, requests])).digest("hex");
    const previous = this.revisions.get(agent.id);
    const revision = previous?.fingerprint === fingerprint ? previous.revision : ++this.serial;
    if (!this.closed) {
      this.revisions.delete(agent.id); this.revisions.set(agent.id, { fingerprint, revision });
      if (this.revisions.size > 512) this.revisions.delete(this.revisions.keys().next().value!);
    }
    const bytes = native?.residentBytes ?? (timeline ? this.timeline.weight(timeline) : fold.residentBytes);
    const data: LoadedSession = { agent, fold, summary, requests, revision, foldRevision: fold.revision, residentBytes: bytes,
      bodies: native?.bodies ?? (timeline ? this.timeline.bodyReader(timeline) : undefined), companionFailed: native?.companionFailed };
    if (!this.closed) {
      this.derived.delete(agent.id);
      if (bytes <= DERIVED_BYTES) this.derived.set(agent.id, { fold, foldRevision: fold.revision, key, at: Date.now(), data, bytes });
      let weight = [...this.derived.values()].reduce((n, entry) => n + entry.bytes, 0);
      for (const [id, entry] of this.derived) {
        if (this.derived.size > 8 || weight > DERIVED_BYTES || Date.now() - entry.at > 120000) {
          this.derived.delete(id); weight -= entry.bytes;
        }
      }
    }
    return data;
  }
  async snapshot(id: string, paseo: PaseoApi) {
    await this.pricing.refresh();
    const data = await this.load(await this.agent(id, paseo), paseo);
    return { summary: data.summary, requests: data.requests, events: data.fold.events };
  }
  async content(id: string, nodeId: number, paseo: PaseoApi, revision?: number) {
    const data = await this.load(await this.agent(id, paseo), paseo);
    if (revision !== undefined && revision !== data.revision) throw new Error("Context revision changed; refresh the session and retry");
    return (await this.contents(data, [nodeId])).get(nodeId)!;
  }
  async contents(data: LoadedSession, ids: readonly number[]) {
    ensureActive(this.lifetime.signal);
    if (data.bodies) return data.bodies(ids, (_id, body) => body);
    const contents = new Map<number, string>();
    for (const id of new Set(ids)) {
      contents.set(id, await this.reader.content(data.agent, id));
      ensureActive(this.lifetime.signal);
    }
    return contents;
  }
  async summary(raw: PaseoAgent, paseo: PaseoApi) {
    return (await this.ledger(raw, paseo)).summary;
  }
  private async ledger(raw: PaseoAgent, paseo: PaseoApi, previous?: Ledger, locate?: (agent: Agent) => Promise<NativeLocation | null>) {
    const agent = agentOf(raw);
    const location = locate ? await locate(agent) : await this.reader.locateSource?.(agent);
    const path = location === undefined ? await this.reader.locate(agent) : location?.path;
    const source = path ? await stat(path) : null;
    ensureActive(this.lifetime.signal);
    const key = JSON.stringify([agent, raw.lastUsage, path, source?.dev, source?.ino, source?.size,
      source?.mtimeMs, source?.ctimeMs, location?.antigravity?.database?.fingerprint, this.pricing.revision]);
    const ttl = path ? 600_000 : 15_000;
    const valid = (entry: Ledger | undefined): entry is Ledger => entry?.key === key && !entry.retry && Date.now() - entry.at < ttl;
    const cached = this.summaries.get(raw.id);
    if (valid(previous)) return previous;
    if (valid(cached)) return cached;
    const data = await this.load(raw, paseo, location);
    const value: Ledger = { at: Date.now(), key, summary: data.summary, retry: data.companionFailed,
      requests: data.requests.map(({ time, usageAt, turn, usage, usageFields, usageSources, parts, costUsd }) =>
        ({ time, usageAt, turn, usage, usageFields, usageSources, parts, costUsd })) };
    if (!this.closed) {
      this.summaries.delete(raw.id);
      if (value.requests.length <= 50000) this.summaries.set(raw.id, value);
      let weight = [...this.summaries.values()].reduce((n, v) => n + v.requests.length, 0);
      for (const [id, old] of this.summaries) {
        if (this.summaries.size > 256 || weight > 50000 || Date.now() - old.at > 600_000) {
          this.summaries.delete(id); weight -= old.requests.length;
        }
      }
    }
    return value;
  }
  async overview(scope: Scope, offset: number, paseo: PaseoApi) {
    void this.pricing.refresh();
    const corpus = await this.readCorpus(paseo);
    return aggregate(corpus.all, corpus.requests, scope, offset, corpus.scanned, corpus.failed);
  }
  async overviewForScreen(scope: Scope, offset: number, paseo: PaseoApi, revision: string) {
    void this.pricing.refresh();
    let corpus = this.corpus ?? (this.scanning?.all.length ? this.scanning : null);
    if (corpus) {
      if (Date.now() >= this.retryCorpusAt) void this.readCorpus(paseo).catch(() => {});
    } else {
      const refresh = this.readCorpus(paseo);
      const signal = this.lifetime.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop: (() => void) | undefined;
      try {
        corpus = await Promise.race([
          refresh,
          new Promise<Corpus | null>((resolve) => {
            timer = setTimeout(() => resolve(this.corpus ?? this.scanning), FIRST_PAINT_BUDGET_MS);
            stop = () => resolve(null);
            signal.addEventListener("abort", stop);
            if (signal.aborted) stop();
          }),
        ]);
      } finally {
        clearTimeout(timer);
        if (stop) signal.removeEventListener("abort", stop);
      }
    }
    if (!corpus || this.closed) throw new Error("Plugin was stopped");
    const running = this.scanning !== null;
    const refreshFailed = this.retryCorpusAt !== 0;
    const covered = corpus.all.length, remaining = corpus.scanned - covered - corpus.failed - corpus.unreadable;
    const version = `${corpus.revision}:${running}:${this.retryCorpusAt}:${new Date().toDateString()}`;
    const coverage = { complete: !corpus.running && remaining === 0 && corpus.failed === 0 && corpus.unreadable === 0, remaining,
      failed: corpus.failed, running: corpus.running, total: corpus.scanned, covered, unsupported: 0,
      unreadable: corpus.unreadable, failedSessions: corpus.failedSessions, unreadableSessions: corpus.unreadableSessions,
      refreshIssues: this.refreshIssues };
    if (this.overviewCacheRevision !== version) {
      this.overviewCache.clear();
      this.overviewCacheRevision = version;
    }
    const key = JSON.stringify([scope, offset]);
    let data = revision === version ? null : this.overviewCache.get(key) ?? null;
    if (revision !== version && !data) {
      data = aggregate(corpus.all, corpus.requests, scope, offset, corpus.scanned, corpus.failed);
      if (this.overviewCache.size >= 12) this.overviewCache.delete(this.overviewCache.keys().next().value!);
      this.overviewCache.set(key, data);
    }
    return { revision: version, coverage, refreshing: running, refreshFailed,
      data };
  }
  async backfill(paseo: PaseoApi) {
    const corpus = await this.readCorpus(paseo, true);
    return { complete: corpus.failed === 0 && corpus.unreadable === 0, remaining: 0, failed: corpus.failed, running: false,
      total: corpus.scanned, covered: corpus.all.length, unsupported: 0, unreadable: corpus.unreadable,
      failedSessions: corpus.failedSessions, unreadableSessions: corpus.unreadableSessions };
  }
  private async readCorpus(paseo: PaseoApi, force = false) {
    if (this.closed) throw new Error("Plugin was stopped");
    if (this.corpusBusy) return this.corpusBusy;
    if (!force && this.corpus && this.corpus.pricingRevision === this.pricing.revision
      && Date.now() - this.corpus.at < CORPUS_TTL_MS) return this.corpus;
    const corpus = this.scanning = { at: 0, pricingRevision: this.pricing.revision, all: [],
      requests: new Map(), ledgers: new Map(), scanned: 0, failed: 0, unreadable: 0, failedSessions: [], unreadableSessions: [],
      running: true, revision: ++this.corpusRevision };
    this.corpusBusy = this.scanCorpus(paseo, corpus);
    try { return await this.corpusBusy; }
    catch (error) {
      if (!this.closed) {
        this.retryCorpusAt = Date.now() + CORPUS_TTL_MS;
        this.refreshIssues = [];
      }
      throw error;
    }
    finally { this.corpusBusy = null; this.scanning = null; }
  }
  private async scanCorpus(paseo: PaseoApi, corpus: Corpus) {
    const signal = this.lifetime.signal;
    const agents = await listAgents(paseo, signal);
    const previous = this.corpus?.ledgers;
    const locate = await this.reader.locateForScan?.(agents.map(agentOf)).catch(() => undefined);
    ensureActive(signal);
    const order = new Map(agents.map((agent, index) => [agent.id, index]));
    agents.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
    corpus.scanned = agents.length;
    corpus.revision = ++this.corpusRevision;
    let cursor = 0;
    await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, async () => {
      while (!signal.aborted && cursor < agents.length) {
        const raw = agents[cursor++];
        try {
          const data = await this.ledger(raw, paseo, previous?.get(raw.id), locate);
          if (signal.aborted) return;
          corpus.all.push(data.summary);
          corpus.requests.set(raw.id, data.requests);
          corpus.ledgers.set(raw.id, data);
        } catch (error) {
          if (signal.aborted) return;
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          const unreadable = code === "EACCES" || code === "EPERM";
          if (unreadable) corpus.unreadable++; else corpus.failed++;
          const issues = unreadable ? corpus.unreadableSessions : corpus.failedSessions;
          if (issues.length < 32) issues.push({ id: raw.id, reason: error instanceof Error ? error.message.slice(0, 300) : "Session read failed" });
        }
        corpus.revision = ++this.corpusRevision;
      }
    }));
    if (signal.aborted) throw new Error("Plugin was stopped");
    // Keep exact sort ties stable even though the workers finish out of order.
    corpus.all.sort((a, b) => order.get(a.agent.id)! - order.get(b.agent.id)!);
    corpus.at = Date.now();
    corpus.running = false;
    corpus.revision = ++this.corpusRevision;
    if (agents.length && corpus.all.length === 0) {
      this.retryCorpusAt = corpus.at + CORPUS_TTL_MS;
      this.refreshIssues = [...corpus.failedSessions, ...corpus.unreadableSessions];
      return corpus;
    }
    this.corpus = corpus;
    this.retryCorpusAt = 0;
    this.refreshIssues = [];
    return corpus;
  }
  private rememberChild(parent: PaseoAgent, child: NativeChild): PaseoAgent {
    const id = nativeId(parent.provider, child.sessionId);
    const agent: PaseoAgent = { ...parent, id, title: child.title, status: "idle",
      createdAt: new Date(child.time).toISOString(), updatedAt: parent.updatedAt, lastUsage: undefined,
      labels: { ...parent.labels, [PARENT]: parent.id },
      persistence: { provider: parent.provider, sessionId: child.sessionId, nativeHandle: child.sessionId } };
    this.nativeMembers.delete(id);
    this.nativeMembers.set(id, agent);
    if (this.nativeMembers.size > 512) this.nativeMembers.delete(this.nativeMembers.keys().next().value!);
    return agent;
  }

  async fleet(id: string, paseo: PaseoApi, options?: { details?: boolean; seed?: LoadedSession }): Promise<FleetData> {
    const signal = this.lifetime.signal;
    const listed = await listAgents(paseo, signal);
    const directory = new Map([...listed, ...this.nativeMembers.values()].map((agent) => [agent.id, agent]));
    const selected = directory.get(id);
    if (!selected) throw new Error("Agent is no longer available");
    let root = selected;
    const visited = new Set<string>();
    while (root.labels[PARENT] && directory.has(root.labels[PARENT]) && !visited.has(root.id)) {
      visited.add(root.id);
      root = directory.get(root.labels[PARENT])!;
    }

    const canonical = new Map<string, PaseoAgent>([[identityOf(root), root]]);
    const aliases = new Map<string, string>();
    for (const raw of directory.values()) {
      const identity = identityOf(raw), existing = canonical.get(identity);
      if (!existing || existing.id.startsWith("native:") && !raw.id.startsWith("native:")) canonical.set(identity, raw);
    }
    for (const raw of directory.values()) {
      const primary = canonical.get(identityOf(raw))!, sessionId = agentOf(raw).sessionId;
      aliases.set(raw.id, primary.id);
      if (sessionId) aliases.set(nativeId(raw.provider, sessionId), primary.id);
    }
    root = canonical.get(identityOf(root))!;
    const children = new Map<string, PaseoAgent[]>();
    for (const raw of directory.values()) {
      const parent = aliases.get(raw.labels[PARENT]);
      if (!parent || aliases.get(raw.id) === parent) continue;
      const rows = children.get(parent) ?? [];
      rows.push(canonical.get(identityOf(raw))!);
      children.set(parent, rows);
    }

    void this.pricing.refresh();
    const members: Summary[] = [], agents: Agent[] = [];
    const loaded = new Map<string, LoadedSession>();
    let failed = 0;
    const queued = new Set([root.id]);
    const queue: Array<{ raw: PaseoAgent; parent: string | null }> = [{ raw: root, parent: null }];
    for (let index = 0; index < queue.length; index++) {
      ensureActive(signal);
      const { raw, parent } = queue[index];
      const agent = { ...agentOf(raw), parentId: parent };
      agents.push(agent);
      const descendants = children.get(raw.id) ?? [];
      try {
        const seed = options?.seed;
        const data = seed?.agent.id === raw.id && (seed.foldRevision === undefined || seed.foldRevision === seed.fold.revision)
          ? seed : await this.load(raw, paseo);
        ensureActive(signal);
        const summary = { ...data.summary, agent: { ...data.summary.agent, parentId: parent } };
        members.push(summary);
        if (options?.details) loaded.set(raw.id, { ...data, agent, summary });
        for (const child of data.fold.collaboration.children.values()) {
          const native = this.rememberChild(raw, child);
          const key = identityOf(native), primary = canonical.get(key) ?? native;
          canonical.set(key, primary);
          aliases.set(native.id, primary.id);
          descendants.push(primary);
        }
      } catch {
        ensureActive(signal);
        failed++;
      }
      for (const child of descendants) {
        if (queued.has(child.id)) continue;
        queued.add(child.id);
        queue.push({ raw: child, parent: raw.id });
      }
    }
    for (const [alias, primary] of aliases) if (!queued.has(primary)) aliases.delete(alias);
    return { rootId: root.id, agents, aliases, members, loaded, failed };
  }
  async collaboration(id: string, paseo: PaseoApi) {
    const family = await this.fleet(id, paseo, { details: true }), records = [];
    for (const { fold, agent } of family.loaded.values()) for (const record of fold.collaboration.records) {
      records.push({ ...record, agentId: agent.id,
        to: family.aliases.get(record.to) ?? family.aliases.get(nativeId(agent.provider, record.to)) ?? record.to });
    }
    return { records: records.sort((a, b) => a.time - b.time), failed: family.failed };
  }
  clear() {
    this.lifetime.abort();
    this.reader.clear(); this.timeline.clear(); this.pricing.clear();
    this.summaries.clear(); this.nativeMembers.clear(); this.revisions.clear(); this.derived.clear(); this.loading.clear();
    this.overviewCache.clear(); this.refreshIssues = []; this.corpus = null; this.scanning = null;
    this.corpusBusy = null;
  }
}

const accountingTime = (request: LedgerRequest) => request.usageAt ?? request.time;
export function aggregate(all: Summary[], requests: ReadonlyMap<string, LedgerRequest[]>, scope: Scope, offset: number, scanned: number, failed: number, now = Date.now()) {
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
    const rows = requests.get(s.agent.id) ?? [];
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
    for (const r of requests.get(s.agent.id) ?? []) {
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
  return { sessions: selected.slice(offset, offset + 24), total: selected.length, scopeTotal: inScope.length, scanned, failed,
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
