import type { PaseoApi } from "@getpaseo/client";
import type { Agent } from "../shared/contracts";
import type { ContextTimeline, FleetDelegation, FleetDetail, FleetDetailCounts, FleetMessage, FleetSummary } from "../shared/core/types";
import { agentReportsOf, delegationTextOf, type CapturedTask, type FleetRecord } from "./collaboration";
import type { ContextService } from "./service";
import { nodeSeq, rowOf, upstreamOf } from "./upstream";
import { parseArgs, text } from "./value";
import { PaseoSubtasks, type PaseoSubtask } from "./subtasks";

type Loaded = Awaited<ReturnType<ContextService["load"]>>;
type Mode = "preview" | "history" | "full";
interface MessageSource { data: Loaded; record: FleetRecord; from: string }
export interface FleetTask {
  id: string; subject: string; description: string; status: CapturedTask["status"] | "failed" | "canceled";
  ownerId?: string; ownerName?: string; blockedBy: string[]; writeScopes: string[]; ready: boolean; warnings: string[];
}
export interface AgentTeam { tasks: FleetTask[]; failure?: string }
export interface FleetRead {
  rootId: string; agents: Agent[]; loaded: Map<string, Loaded>; failed: number; total: number;
  aliases?: ReadonlyMap<string, string>;
  subtasks?: Map<string, PaseoSubtask[]>; subtaskFailures?: number;
}
const PREVIEW_MESSAGES = 80;
const PREVIEW_TEXT = 400;
const RECENT_BYTES = 48 * 1024 * 1024;
const clip = (value: string, max: number) => value.length <= max ? value : value.slice(0, max) + "…";
const taskKey = (owner: string, id: string) => `${owner}:task:${id}`;

/** Limits concurrent disk/timeline reads without retaining an extra cache of session folds. */
async function mapBounded<T, U>(values: readonly T[], read: (value: T) => Promise<U>): Promise<U[]> {
  const result: U[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      result[index] = await read(values[index]);
    }
  }));
  return result;
}

function resolverOf(family: FleetRead) {
  const aliases = new Map(family.aliases), names = new Map<string, string | null>();
  for (const agent of family.agents) {
    aliases.set(agent.id, agent.id);
    if (agent.sessionId) {
      aliases.set(`${agent.provider}:${agent.sessionId}`, agent.id);
      aliases.set(`native:${agent.provider}:${agent.sessionId}`, agent.id);
    }
    names.set(agent.title, names.has(agent.title) ? null : agent.id);
  }
  return (value: string, provider: string): string =>
    aliases.get(value) ?? aliases.get(`${provider}:${value}`) ?? names.get(value) ?? value;
}

function sourcesOf(family: FleetRead) {
  const resolve = resolverOf(family), incoming = new Map<string, MessageSource[]>();
  for (const data of family.loaded.values()) for (const entry of data.fold.collaboration.records) {
    if (entry.kind !== "message" && entry.kind !== "report") continue;
    if (entry.kind === "message" && entry.status === "failed") continue;
    const recipients = entry.kind === "report" ? [data.agent.id]
      : entry.to === "*" ? family.agents.filter((a) => a.id !== data.agent.id).map((a) => a.id)
      : entry.to ? [resolve(entry.to, data.agent.provider)] : [];
    const from = entry.kind === "report" && entry.from ? resolve(entry.from, data.agent.provider) : data.agent.id;
    for (const recipient of recipients) {
      const rows = incoming.get(recipient) ?? [];
      rows.push({ data, record: entry, from }); incoming.set(recipient, rows);
    }
  }
  for (const rows of incoming.values()) rows.sort((a, b) => a.record.time - b.record.time
    || a.data.agent.id.localeCompare(b.data.agent.id) || a.record.id.localeCompare(b.record.id));
  return { incoming, resolve };
}

// Multiple senders or child reports can share a source ordinal. Keep each message
// address stable across preview/full reads without depending on the family size.
function messageSeq(source: MessageSource): number {
  let hash = 2166136261;
  for (const char of `${source.data.agent.id}\0${source.record.id}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  return nodeSeq(source.data.fold, source.record.nodeId) + (hash + 1) / 4294967297 / 1000;
}

export function teamOfFleet(family: FleetRead): AgentTeam {
  const resolve = resolverOf(family), tasks: FleetTask[] = [];
  for (const agent of family.agents) for (const task of family.loaded.get(agent.id)?.fold.collaboration.tasks.values() ?? []) {
    const data = family.loaded.get(agent.id)!;
    const owner = task.owner === "@self" ? data.agent.id : task.owner ? resolve(task.owner, data.agent.provider) : undefined;
    const knownOwner = owner && family.agents.some((a) => a.id === owner) ? owner : undefined;
    const blockedBy = task.blockedBy.map((id) => taskKey(data.agent.id, id));
    tasks.push({ id: taskKey(data.agent.id, task.id), subject: task.subject, description: task.description,
      status: task.status, blockedBy, writeScopes: task.writeScopes ?? [], ready: false, warnings: [],
      ...(knownOwner ? { ownerId: knownOwner } : task.owner && task.owner !== "@self" ? { ownerName: task.owner } : {}) });
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    task.ready = task.status === "pending" && task.blockedBy.every((id) => byId.get(id)?.status === "completed");
    for (const id of task.blockedBy) if (!byId.has(id)) task.warnings.push(`Dependency ${id} has not been captured.`);
  }
  for (const [agentId, subtasks] of family.subtasks ?? []) for (const task of subtasks) {
    const provider = family.agents.find((agent) => agent.id === agentId)?.provider ?? "";
    const source = family.loaded.get(agentId);
    const assignment = source?.fold.collaboration.records.find((row) => source.fold.nodes[row.nodeId]?.callId === task.callId);
    const childId = task.childId || assignment?.to;
    const owner = childId ? resolve(childId, provider) : undefined;
    tasks.push({ id: `${agentId}:subtask:${task.callId}`, subject: task.subject, description: task.description,
      status: task.status, blockedBy: [], writeScopes: [], ready: false, warnings: [],
      ...(owner && family.agents.some((agent) => agent.id === owner) ? { ownerId: owner } : owner ? { ownerName: owner } : {}) });
  }
  return { tasks, ...(family.failed || family.subtaskFailures ? { failure: "Some fleet sessions or Paseo subtask timelines could not be read; captured task state may be incomplete." } : {}) };
}

/** Adds only captured task data; no provider membership/ownership is invented. */
export function fleetRow(agent: Agent, team: AgentTeam, head?: ContextTimeline) {
  const row = rowOf(agent, head);
  return { ...row, projectionValues: { ...row.projectionValues, agentTeam: team } };
}
export class UiFleet {
  private subtasks = new PaseoSubtasks();
  private recent = new Map<string, { at: number; revision?: number; bytes: number; pending: Promise<FleetRead> }>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;
  private heads = new WeakMap<Loaded, ContextTimeline>();
  private taskReads = new WeakMap<FleetRead, Promise<FleetRead>>();
  constructor(private service: Pick<ContextService, "agent" | "load" | "fleet" | "content">) {}
  clear() {
    this.closed = true; this.subtasks.clear(); this.recent.clear(); this.heads = new WeakMap(); this.taskReads = new WeakMap();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  async read(id: string, paseo: PaseoApi, seed?: Loaded, includeSubtasks = true): Promise<FleetRead> {
    const family = await this.readFamily(id, paseo, seed);
    if (!includeSubtasks) return family;
    let pending = this.taskReads.get(family);
    if (!pending) {
      pending = this.readSubtasks(family, paseo);
      this.taskReads.set(family, pending);
    }
    return pending;
  }

  private async readFamily(id: string, paseo: PaseoApi, seed?: Loaded): Promise<FleetRead> {
    if (this.closed) throw new Error("Plugin was stopped");
    const key = id;
    const known = this.recent.get(key);
    if (known && Date.now() - known.at < 1000 && (!seed || known.revision === seed.revision)) {
      const family = await known.pending;
      if (this.closed) throw new Error("Plugin was stopped");
      if ([...family.loaded.values()].every((data) => data.foldRevision === undefined || data.foldRevision === data.fold.revision)) return family;
      if (this.recent.get(key) === known) this.recent.delete(key);
    }
    const pending = this.service.fleet(id, paseo, { details: true, seed }).then((family): FleetRead => ({ ...family, total: family.agents.length }));
    const entry = { at: Infinity, revision: seed?.revision, bytes: 0, pending };
    if (!this.closed) {
      for (const [key, value] of this.recent) if (Date.now() - value.at >= 1000) this.recent.delete(key);
      this.recent.delete(key); this.recent.set(key, entry);
      while (this.recent.size > 4) this.recent.delete(this.recent.keys().next().value!);
    }
    try {
      const family = await entry.pending;
      if (this.closed) throw new Error("Plugin was stopped");
      entry.bytes = [...family.loaded.values()].reduce((sum, data) => sum + (data.residentBytes ?? data.fold.residentBytes), 0);
      if (entry.bytes > RECENT_BYTES && this.recent.get(key) === entry) this.recent.delete(key);
      let bytes = [...this.recent.values()].reduce((sum, item) => sum + item.bytes, 0);
      for (const [id, item] of this.recent) {
        if (bytes <= RECENT_BYTES) break;
        this.recent.delete(id);
        bytes -= item.bytes;
      }
      return family;
    }
    catch (error) { if (this.recent.get(key) === entry) this.recent.delete(key); throw error; }
    finally {
      // Retain only a brief burst of concurrent graph/summary/batch requests.
      if (!this.closed && this.recent.get(key) === entry) {
        entry.at = Date.now();
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          if (this.recent.get(key) === entry) this.recent.delete(key);
        }, 1000);
        this.timers.add(timer); timer.unref();
      }
    }
  }
  private async readSubtasks(family: FleetRead, paseo: PaseoApi): Promise<FleetRead> {
    if (this.closed) throw new Error("Plugin was stopped");
    const subtasks = new Map<string, PaseoSubtask[]>();
    let subtaskFailures = 0;
    await mapBounded(family.agents.filter((agent) => !agent.id.startsWith("native:")), async (agent) => {
      try { subtasks.set(agent.id, await this.subtasks.read(agent.id, agent.updatedAt, paseo)); }
      catch { subtaskFailures++; }
    });
    if (this.closed) throw new Error("Plugin was stopped");
    return { ...family, subtasks, subtaskFailures };
  }
  rows(family: FleetRead, selectedId?: string, includeTasks = true) {
    const selected = selectedId ? family.aliases?.get(selectedId) : undefined;
    const visibleId = (id: string) => selected === id && selectedId ? selectedId : id;
    const team = includeTasks ? teamOfFleet(family) : undefined;
    if (team && selected && selected !== selectedId) {
      for (const task of team.tasks) if (task.ownerId) task.ownerId = visibleId(task.ownerId);
    }
    return family.agents.map((agent) => {
      const data = family.loaded.get(agent.id);
      if (data && !this.heads.has(data)) this.heads.set(data, upstreamOf(data, true).head);
      const head = data ? this.heads.get(data) : undefined;
      const row = { ...agent, id: visibleId(agent.id), parentId: agent.parentId ? visibleId(agent.parentId) : null };
      return team && agent.id === family.rootId ? fleetRow(row, team, head) : rowOf(row, head);
    });
  }
  private delegations(family: FleetRead, data: Loaded): FleetDelegation[] {
    const resolve = resolverOf(family);
    return data.fold.collaboration.records.filter((r) => r.kind === "delegation" && r.to && r.status !== "failed").map((r): FleetDelegation => {
      const to = resolve(r.to, data.agent.provider);
      const child = data.fold.collaboration.children.get(r.to);
      return { seq: nodeSeq(data.fold, r.nodeId), time: r.time, to, mode: child?.mode ?? "unknown", label: r.title };
    });
  }
  private messageText(source: MessageSource, value: string): string {
    if (source.record.contentKind === "delegation-result") return delegationTextOf(value);
    if (source.record.contentKind === "report") {
      const report = agentReportsOf(value).find((r) => r.from === source.record.from);
      if (!report) throw new Error("Agent report is no longer available");
      return report.text;
    }
    const args = parseArgs(value);
    return text(args.message ?? args.content ?? args.prompt ?? args.description ?? args.subject ?? args.explanation) || value;
  }
  private async bodies(data: Loaded, ids: number[], paseo: PaseoApi) {
    if (data.bodies) return data.bodies(ids, (_id, body) => body);
    return new Map(await mapBounded([...new Set(ids)], async (id) => [id, await this.service.content(data.agent.id, id, paseo)] as const));
  }
  async detail(family: FleetRead, id: string, mode: Mode, paseo: PaseoApi): Promise<FleetDetail | null> {
    const resolve = resolverOf(family);
    const canonicalId = resolve(id, family.agents.find((a) => a.id === family.rootId)?.provider ?? "");
    const data = family.loaded.get(canonicalId);
    if (!data) return null;
    const { incoming } = sourcesOf(family), all = incoming.get(canonicalId) ?? [];
    const shown = mode === "preview" ? all.slice(-PREVIEW_MESSAGES) : all;
    const first = data.fold.nodes.find((n) => n.category === "user" && !n.replayed);
    const last = data.fold.nodes.findLast((n) => n.category === "assistant" && n.gone === undefined);
    const promptNodes = first ? data.fold.nodes.filter((n) => n.category === "user" && n.line === first.line) : [];
    const replyNodes = last ? data.fold.nodes.filter((n) => n.category === "assistant" && n.line === last.line) : [];
    const reads = new Map<Loaded, number[]>();
    if (mode !== "preview") {
      reads.set(data, [...promptNodes, ...replyNodes].map((node) => node.id));
      for (const source of shown) {
        const ids = reads.get(source.data) ?? [];
        ids.push(source.record.nodeId);
        reads.set(source.data, ids);
      }
    }
    const bodies = new Map(await mapBounded([...reads], async ([source, ids]) => [source, await this.bodies(source, ids, paseo)] as const));
    const messages = shown.map((source): FleetMessage => {
      const value = mode === "preview" ? source.record.title : this.messageText(source, bodies.get(source.data)!.get(source.record.nodeId)!);
      const clipped = mode === "preview" && (value.length > PREVIEW_TEXT || (source.record.textLength ?? value.length) > value.length);
      const fromName = family.agents.find((a) => a.id === source.from)?.title;
      const body = mode === "preview" ? clip(value, PREVIEW_TEXT) : value;
      return { seq: messageSeq(source), time: source.record.time, from: source.from, ...(fromName ? { fromName } : {}),
        kind: source.record.kind === "report" ? "settled" : "relay", text: body,
        ...(source.record.kind === "report" ? { report: body,
          summary: source.record.status === "failed" ? "Agent reported an error." : "Agent completed." } : {}),
        ...(clipped ? { clipped: true } : {}) };
    });
    const prompt = first ? mode === "preview" ? clip(promptNodes.map((n) => n.preview).join("\n"), 1600)
      : promptNodes.map((n) => bodies.get(data)!.get(n.id)).join("\n") : undefined;
    const reply = last ? mode === "preview" ? clip(replyNodes.map((n) => n.preview).join("\n"), 300)
      : replyNodes.map((n) => bodies.get(data)!.get(n.id)).join("\n") : undefined;
    const parent = data.agent.parentId ? family.loaded.get(resolve(data.agent.parentId, data.agent.provider)) : undefined;
    const child = parent && [...parent.fold.collaboration.children.values()].find((c) => c.sessionId === data.agent.sessionId);
    return { descriptor: { mode: child?.mode ?? "continuable", label: data.agent.title,
      agentProvider: data.agent.provider, agentModel: data.summary.agent.model },
      ...(prompt === undefined ? {} : { initialPrompt: prompt }),
      ...(reply === undefined || !last ? {} : { lastReply: { time: last.time, text: reply } }),
      messages, messagesTotal: all.length, delegations: this.delegations(family, data),
      truncated: shown.length < all.length || family.failed > 0 };
  }
  async summary(family: FleetRead, paseo: PaseoApi, requestedId = family.rootId): Promise<FleetSummary> {
    const { incoming } = sourcesOf(family), counts: Record<string, FleetDetailCounts> = {};
    const rootId = family.aliases?.get(requestedId) === family.rootId ? requestedId : family.rootId;
    // Incoming messages can originate in any member. An unread source prevents
    // attesting complete totals even for a recipient whose own log was read.
    if (family.failed === 0) for (const [id, data] of family.loaded) {
      counts[id === family.rootId ? rootId : id] = { readAt: data.agent.updatedAt, messagesTotal: incoming.get(id)?.length ?? 0,
        delegationsCount: this.delegations(family, data).length };
    }
    const root = family.agents.find((a) => a.id === family.rootId);
    const detail = await this.detail(family, family.rootId, "preview", paseo);
    if (!detail) throw new Error("Fleet root could not be read");
    return { rootId, ...(root ? { rootCreatedAt: root.createdAt } : {}), detail, counts,
      familySize: family.total,
      members: family.agents.filter((a) => a.id !== family.rootId).map((agent) => ({
        id: agent.id, name: agent.title, label: agent.title, createdAt: agent.createdAt,
      })) };
  }
  async handle(body: Record<string, unknown>, paseo: PaseoApi) {
    const batch = body.batch !== null && typeof body.batch === "object" ? body.batch as Record<string, unknown> : {};
    const ids = Array.isArray(batch.ids) ? [...new Set(batch.ids.filter((id): id is string => typeof id === "string" && !!id))] : [];
    if (ids.length > 16) throw new Error("Fleet batches support at most 16 agents");
    const id = text(body.sessionId ?? batch.rootId) || ids[0];
    if (!id) throw new Error("An agent is required for a fleet request");
    const family = await this.read(id, paseo, undefined, false);
    if (body.summary === true) return { ok: true, value: await this.summary(family, paseo, id) };
    const mode: Mode = body.full === true ? "full" : body.history === true || batch.mode === "history" ? "history" : "preview";
    if (!Array.isArray(batch.ids)) return { ok: true, value: await this.detail(family, id, mode, paseo) };
    const rows: Record<string, FleetDetail> = {}, missing: string[] = [];
    await mapBounded(ids, async (agentId) => {
      try {
        const detail = await this.detail(family, agentId, mode, paseo);
        if (detail) rows[agentId] = detail; else missing.push(agentId);
      } catch { missing.push(agentId); }
    });
    return { ok: true, value: { rows, missing, total: ids.length } };
  }
}
