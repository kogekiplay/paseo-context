import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { stat } from "node:fs/promises";
import type { Agent, Request, Scope, Summary } from "../shared/contracts";
import type { ContextFold } from "./fold";
import { SessionReader, type ReadBodies, type ReadMedia } from "./reader";
import { Pricing } from "./pricing";
import { detachSlice, timestamp } from "./value";
import { createHash } from "node:crypto";
import { ensureActive, nextCursor } from "./paging";
import { TimelineReader, timelineFingerprint } from "./timeline";
import type { NativeLocation } from "./native-paths";
import type { NativeChild } from "./collaboration";
import { antigravityConversationId, antigravityPersistenceId } from "./antigravity-log";
import { MIB, sessionReadBudget, type ReadBudget } from "./read-budget";
import { RetainedCache, SESSION_IDLE_MS } from "./retained-cache";
import { aggregateScope, overviewPage, sessionShard, type SessionShard } from "./corpus";
import { imageUrlOf } from "./images";
import { fleetResolver } from "./fleet-aliases";

export { aggregate } from "./corpus";

const CORPUS_TTL_MS = 10_000;
const CORPUS_IDLE_MS = 180_000;
const FIRST_PAINT_BUDGET_MS = 400;
const SCAN_CONCURRENCY = 4;
const DERIVED_BYTES = 48 * MIB;
const SUMMARY_BYTES = 16 * MIB;
interface Reader {
  read(agent: Agent, location?: NativeLocation | null): Promise<{
    entry: { fold: ContextFold }; bodies?: ReadBodies; media?: ReadMedia; residentBytes?: number;
    metadataOnly?: boolean; companionFailed?: boolean;
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
  media?: ReadMedia;
  residentBytes?: number;
  companionFailed?: boolean;
}
const PARENT = "paseo.parent-agent-id";
const nativeId = (provider: string, sessionId: string) => `native:${provider}:${sessionId}`;
const identityOf = (raw: PaseoAgent) => {
  const sessionId = agentOf(raw).sessionId;
  return JSON.stringify([raw.provider, sessionId === null ? "agent" : "session", sessionId ?? raw.id]);
};
type AgentDirectory = ReadonlyMap<string, PaseoAgent>;
const explicitParent = (raw: PaseoAgent, directory: AgentDirectory) => directory.get(raw.labels[PARENT]);

function canClaimChild(parent: PaseoAgent, child: PaseoAgent, directory: AgentDirectory) {
  const explicit = explicitParent(child, directory);
  return !explicit || identityOf(explicit) === identityOf(parent);
}
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
  shards: Map<string, SessionShard>;
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
  const sessionId = a.provider === "antigravity"
    ? antigravityConversationId(a.persistence?.nativeHandle ?? null)
      ?? antigravityConversationId(a.persistence?.sessionId ?? null)
      ?? antigravityConversationId(a.runtimeInfo?.sessionId ?? null)
      ?? antigravityPersistenceId(a.persistence?.metadata?.pluginProviderPersistence)
    : handle;
  return { id: a.id, workspaceId: a.workspaceId ?? null, parentId: a.labels[PARENT] ?? null,
    title: a.title || a.id, cwd: a.cwd, provider: a.provider, model: a.runtimeInfo?.model ?? a.model ?? "",
    sessionId,
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
  private budget: ReadBudget;
  private timeline: TimelineReader;
  constructor(readonly reader: Reader = new SessionReader(), readonly pricing = new Pricing()) {
    this.budget = reader instanceof SessionReader ? reader.budget : sessionReadBudget;
    this.timeline = new TimelineReader(this.lifetime.signal, this.budget);
  }
  private summaries = new RetainedCache<SessionShard>(256, SUMMARY_BYTES);
  private corpus: Corpus | null = null;
  private corpusTimer?: ReturnType<typeof setTimeout>;
  private scanning: Corpus | null = null;
  private corpusBusy: Promise<Corpus> | null = null;
  private corpusRevision = 0;
  private lifetime = new AbortController();
  private retryCorpusAt = 0;
  private refreshIssues: Corpus["failedSessions"] = [];
  private overviewCache = new Map<string, ReturnType<typeof aggregateScope>>();
  private overviewCacheRevision = "";
  private get closed() { return this.lifetime.signal.aborted; }
  private nativeMembers = new Map<string, PaseoAgent>();
  private discoveredChildren = new Map<string, { revision: number; ids: Set<string> }>();
  private revisions = new Map<string, { fingerprint: string; revision: number }>();
  private serial = 0;
  // Only the source cache or an active caller owns the Entry/Frame. A derived
  // value can refer back to that snapshot without keeping its weak key alive.
  private derivations = new WeakMap<object, Map<string, LoadedSession>>();
  private derived = new RetainedCache<{ source: WeakRef<object>; key: string }>(8, DERIVED_BYTES, SESSION_IDLE_MS,
    (id, entry) => {
      const source = entry.source.deref();
      if (source) this.derivations.get(source)?.delete(id);
    });
  private loading = new Map<string, Promise<LoadedSession>>();
  async directory(paseo: PaseoApi) {
    const agents = await listAgents(paseo, this.lifetime.signal);
    const ids = new Set(agents.map((raw) => raw.id)), sessions = new Set(agents.map(identityOf));
    return [...agents, ...[...this.nativeMembers.values()].filter((raw) =>
      !ids.has(raw.id) && !sessions.has(identityOf(raw)))];
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
  async load(raw: PaseoAgent, paseo: PaseoApi, location?: NativeLocation | null, directory?: AgentDirectory): Promise<LoadedSession> {
    // Simultaneous surfaces share a read. Different agent metadata must never
    // inherit an in-flight result from an older snapshot.
    const key = JSON.stringify([agentOf(raw), raw.lastUsage, this.pricing.revision]);
    let pending = this.loading.get(key);
    if (!pending) {
      pending = this.loadSession(raw, paseo, key, location);
      this.loading.set(key, pending);
    }
    try {
      const data = await pending;
      const known = this.discoveredChildren.get(raw.id);
      if (!directory && (!known || known.revision < data.revision)) {
        for (const child of data.fold.collaboration.children.values()) {
          if (!child.paseoAgent) continue;
          const listed = await listAgents(paseo, this.lifetime.signal).catch(() => {
            ensureActive(this.lifetime.signal);
            return [];
          });
          directory = new Map([...this.nativeMembers, ...listed.map((agent) => [agent.id, agent] as const)]);
          break;
        }
      }
      if (directory || known?.revision !== data.revision) this.replaceChildEdges(data, directory);
      return data;
    } finally { if (this.loading.get(key) === pending) this.loading.delete(key); }
  }
  private async loadSession(raw: PaseoAgent, paseo: PaseoApi, key: string, location?: NativeLocation | null): Promise<LoadedSession> {
    ensureActive(this.lifetime.signal);
    const agent = agentOf(raw);
    const native = await this.reader.read(agent, location);
    const timeline = native ? null : await this.timeline.read(agent.id, paseo);
    const source = native?.entry ?? timeline!;
    const { fold } = source;
    ensureActive(this.lifetime.signal);
    const cached = this.derived.get(agent.id);
    if (cached?.key === key && cached.source.deref() === source) {
      const data = this.derivations.get(source)?.get(agent.id);
      if (data?.foldRevision === fold.revision && data.companionFailed === native?.companionFailed) {
        return data;
      }
    }
    for (const child of fold.collaboration.children.values()) {
      if (!child.paseoAgent) this.rememberChild(raw, child);
    }
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
    const fingerprint = native ? createHash("sha256").update(JSON.stringify([key, fold.epoch, fold.revision])).digest("hex")
      : timelineFingerprint(key, fold, summary, requests);
    const previous = this.revisions.get(agent.id);
    const revision = previous?.fingerprint === fingerprint ? previous.revision : ++this.serial;
    if (!this.closed) {
      this.revisions.delete(agent.id); this.revisions.set(agent.id, { fingerprint, revision });
      if (this.revisions.size > 512) this.revisions.delete(this.revisions.keys().next().value!);
    }
    const bytes = native?.residentBytes ?? (timeline ? this.timeline.weight(timeline) : fold.residentBytes);
    const data: LoadedSession = { agent, fold, summary, requests, revision, foldRevision: fold.revision, residentBytes: bytes,
      bodies: native?.bodies ?? (timeline ? this.timeline.bodyReader(timeline) : undefined), media: native?.media,
      companionFailed: native?.companionFailed };
    const weight = 1024 + requests.length * 192 + (summary.intervals?.length ?? 0) * 64
      + summary.activity.reduce((total, day) => total + 128 + 64 * (day.tools.length + day.skills.length + day.programs.length), 0);
    if (this.derived.set(agent.id, { source: new WeakRef(source), key }, weight)) {
      const entries = this.derivations.get(source) ?? new Map<string, LoadedSession>();
      entries.set(agent.id, data);
      this.derivations.set(source, entries);
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
  async image(id: string, nodeId: number, index: number, maxBytes: number, paseo: PaseoApi) {
    const data = await this.load(await this.agent(id, paseo), paseo);
    const node = data.fold.nodes[nodeId];
    if (!node || index >= (node.images ?? 1)) return null;
    if (data.agent.provider === "antigravity" && node.images && data.media) return data.media(nodeId, index, maxBytes);
    if (index === 0) {
      const value = (await this.contents(data, [nodeId])).get(nodeId);
      const inline = imageUrlOf(value, maxBytes);
      if (inline) return inline;
    }
    return null;
  }
  async summary(raw: PaseoAgent, paseo: PaseoApi) {
    return (await this.shard(raw, paseo)).summary;
  }
  private async shard(raw: PaseoAgent, paseo: PaseoApi, previous?: SessionShard, locate?: (agent: Agent) => Promise<NativeLocation | null>) {
    const agent = agentOf(raw);
    const location = locate ? await locate(agent) : await this.reader.locateSource?.(agent);
    const path = location === undefined ? await this.reader.locate(agent) : location?.path;
    const source = path ? await stat(path) : null;
    ensureActive(this.lifetime.signal);
    const key = JSON.stringify([agent, raw.lastUsage, path, source?.dev, source?.ino, source?.size,
      source?.mtimeMs, source?.ctimeMs, location?.antigravity?.database?.fingerprint, this.pricing.revision]);
    const ttl = path ? 600_000 : 15_000;
    const transient = location?.antigravity?.database?.fingerprint === "";
    const valid = (entry: SessionShard | undefined): entry is SessionShard =>
      !transient && entry?.key === key && !entry.retry && Date.now() - entry.at < ttl;
    if (valid(previous)) return previous;
    const cached = this.summaries.get(raw.id);
    if (valid(cached)) return cached;
    const data = await this.load(raw, paseo, location);
    const value = sessionShard(data.summary, data.requests, key, Date.now(), data.companionFailed);
    if (!this.closed && !transient) this.summaries.set(raw.id, value, value.bytes);
    return value;
  }
  async overview(scope: Scope, offset: number, paseo: PaseoApi) {
    void this.pricing.refresh();
    const corpus = await this.readCorpus(paseo);
    return overviewPage(this.aggregateCorpus(corpus, scope), offset);
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
    this.touchCorpus();
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
    const key = JSON.stringify(scope);
    let data = revision === version ? null : this.overviewCache.get(key) ?? null;
    if (revision !== version && !data) {
      data = this.aggregateCorpus(corpus, scope);
      if (this.overviewCache.size >= 12) this.overviewCache.delete(this.overviewCache.keys().next().value!);
      this.overviewCache.set(key, data);
    }
    return { revision: version, coverage, refreshing: running, refreshFailed,
      data: data ? overviewPage(data, offset) : null };
  }
  private aggregateCorpus(corpus: Corpus, scope: Scope) {
    return aggregateScope(corpus.all, corpus.shards, scope, corpus.scanned, corpus.failed);
  }
  async backfill(paseo: PaseoApi) {
    const corpus = await this.readCorpus(paseo, true);
    return { complete: corpus.failed === 0 && corpus.unreadable === 0, remaining: 0, failed: corpus.failed, running: false,
      total: corpus.scanned, covered: corpus.all.length, unsupported: 0, unreadable: corpus.unreadable,
      failedSessions: corpus.failedSessions, unreadableSessions: corpus.unreadableSessions };
  }
  private async readCorpus(paseo: PaseoApi, force = false) {
    if (this.closed) throw new Error("Plugin was stopped");
    this.touchCorpus();
    if (this.corpusBusy) return this.corpusBusy;
    if (!force && this.corpus && this.corpus.pricingRevision === this.pricing.revision
      && Date.now() - this.corpus.at < CORPUS_TTL_MS) return this.corpus;
    const corpus = this.scanning = { at: 0, pricingRevision: this.pricing.revision, all: [],
      shards: new Map(), scanned: 0, failed: 0, unreadable: 0, failedSessions: [], unreadableSessions: [],
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
  private touchCorpus() {
    clearTimeout(this.corpusTimer);
    this.corpusTimer = setTimeout(() => {
      this.corpusTimer = undefined;
      this.corpus = null;
      this.overviewCache.clear();
      this.overviewCacheRevision = "";
      this.retryCorpusAt = 0;
      this.refreshIssues = [];
    }, CORPUS_IDLE_MS);
    this.corpusTimer.unref();
  }

  private async scanCorpus(paseo: PaseoApi, corpus: Corpus) {
    const signal = this.lifetime.signal;
    const { agents, locate } = await this.budget.run(16 * MIB, signal, async () => {
      const agents = await listAgents(paseo, signal);
      const locate = await this.reader.locateForScan?.(agents.map(agentOf)).catch(() => undefined);
      return { agents, locate };
    });
    const previous = this.corpus?.shards;
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
          const data = await this.shard(raw, paseo, previous?.get(raw.id), locate);
          if (signal.aborted) return;
          corpus.all.push(data.summary);
          corpus.shards.set(raw.id, data);
        } catch (error) {
          if (signal.aborted) return;
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          const unreadable = code === "EACCES" || code === "EPERM";
          if (unreadable) corpus.unreadable++; else corpus.failed++;
          const issues = unreadable ? corpus.unreadableSessions : corpus.failedSessions;
          if (issues.length < 32) issues.push({ id: raw.id, reason: error instanceof Error ? detachSlice(error.message, 300) : "Session read failed" });
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
    if (this.corpusTimer) this.corpus = corpus;
    this.overviewCache.clear();
    this.overviewCacheRevision = "";
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

  private replaceChildEdges(data: LoadedSession, directory?: AgentDirectory) {
    const { agent, fold, revision } = data;
    const previous = this.discoveredChildren.get(agent.id);
    if (previous && previous.revision > revision) return;
    const ids = new Set<string>();
    const parent = directory?.get(agent.id);
    for (const child of fold.collaboration.children.values()) {
      if (!child.paseoAgent || child.sessionId === agent.id) continue;
      const existing = directory?.get(child.sessionId);
      if (directory && existing && parent && canClaimChild(parent, existing, directory)) ids.add(child.sessionId);
      if (ids.size === 512) break;
    }
    if (!previous && !ids.size && agent.provider !== "antigravity") return;
    this.discoveredChildren.delete(agent.id);
    this.discoveredChildren.set(agent.id, { revision, ids });
    let size = 0;
    for (const children of this.discoveredChildren.values()) size += Math.max(1, children.ids.size);
    for (const [parent, children] of this.discoveredChildren) {
      if (size <= 512) break;
      size -= Math.max(1, children.ids.size);
      this.discoveredChildren.delete(parent);
    }
  }

  async fleet(id: string, paseo: PaseoApi, options?: { details?: boolean; seed?: LoadedSession }): Promise<FleetData> {
    const signal = this.lifetime.signal;
    const listed = await listAgents(paseo, signal);
    const listedById = new Map(listed.map((agent) => [agent.id, agent]));
    const directory = new Map([...this.nativeMembers, ...listedById]);
    const selected = directory.get(id);
    if (!selected) throw new Error("Agent is no longer available");
    for (const [parentId, edge] of this.discoveredChildren) {
      const parent = directory.get(parentId);
      if (!parent) continue;
      for (const id of edge.ids) {
        const child = directory.get(id);
        if (!child || !canClaimChild(parent, child, directory)) edge.ids.delete(id);
      }
    }
    let root = selected;
    const visited = new Set<string>();
    let staged: LoadedSession | undefined;
    const inspected = new Set<string>();
    const loadMember = async (raw: PaseoAgent) => {
      const seed = staged?.agent.id === raw.id ? staged : options?.seed;
      const latest = this.revisions.get(raw.id)?.revision;
      if (seed?.agent.id === raw.id && (latest === undefined || latest <= seed.revision)
        && (seed.foldRevision === undefined || seed.foldRevision === seed.fold.revision)) {
        this.replaceChildEdges(seed, directory);
        return seed;
      }
      return this.load(raw, paseo, undefined, directory);
    };
    let searches = 8;
    while (!visited.has(root.id)) {
      visited.add(root.id);
      const explicit = explicitParent(root, directory);
      if (explicit) {
        if (visited.has(explicit.id)) break;
        root = explicit;
        continue;
      }
      const matches = async (candidate: PaseoAgent) => {
        inspected.add(candidate.id);
        try {
          const data = await loadMember(candidate);
          if (!data.fold.collaboration.child(root.id, true)) return false;
          staged = data;
          return true;
        } catch { ensureActive(signal); return false; }
      };
      let parent: PaseoAgent | undefined;
      for (const [parentId, edge] of this.discoveredChildren) {
        const candidate = directory.get(parentId);
        if (candidate && !visited.has(parentId) && edge.ids.has(root.id) && await matches(candidate)) { parent = candidate; break; }
      }
      if (!parent && searches) {
        const candidates = listed.filter((candidate) => candidate.provider === "antigravity" && !visited.has(candidate.id)
          && !inspected.has(candidate.id) && timestamp(candidate.createdAt) <= timestamp(root.createdAt)
          && (candidate.workspaceId ?? null) === (root.workspaceId ?? null))
          .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
        for (const candidate of candidates.slice(0, searches)) {
          searches--;
          if (await matches(candidate)) { parent = candidate; break; }
        }
      }
      if (!parent) break;
      root = parent;
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
        const data = await loadMember(raw);
        ensureActive(signal);
        const summary = { ...data.summary, agent: { ...data.summary.agent, parentId: parent } };
        members.push(summary);
        if (options?.details) loaded.set(raw.id, { ...data, agent, summary });
        for (const child of data.fold.collaboration.children.values()) {
          if (child.paseoAgent) {
            const existing = listedById.get(child.sessionId);
            if (existing && canClaimChild(raw, existing, directory)) descendants.push(canonical.get(identityOf(existing))!);
            continue;
          }
          const key = JSON.stringify([raw.provider, "session", child.sessionId]);
          const existing = canonical.get(key);
          if (existing) {
            descendants.push(existing);
            continue;
          }
          const native = this.rememberChild(raw, child);
          canonical.set(key, native);
          directory.set(native.id, native);
          aliases.set(native.id, native.id);
          descendants.push(native);
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
    const resolve = fleetResolver(family.agents, family.aliases);
    for (const { fold, agent } of family.loaded.values()) for (const record of fold.collaboration.records) {
      const { paseoAgent, ...visible } = record;
      records.push({ ...visible, agentId: agent.id, to: resolve(record.to, agent.provider, paseoAgent) });
    }
    return { records: records.sort((a, b) => a.time - b.time), failed: family.failed };
  }
  clear() {
    this.lifetime.abort();
    clearTimeout(this.corpusTimer);
    this.corpusTimer = undefined;
    this.reader.clear(); this.timeline.clear(); this.pricing.clear();
    this.summaries.clear(); this.nativeMembers.clear(); this.discoveredChildren.clear(); this.revisions.clear(); this.derived.clear(); this.loading.clear();
    this.overviewCache.clear(); this.refreshIssues = []; this.corpus = null; this.scanning = null;
    this.corpusBusy = null;
  }
}
