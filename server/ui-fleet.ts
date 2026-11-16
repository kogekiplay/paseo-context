import type { PaseoApi } from "@getpaseo/client";
import type { Agent } from "../shared/contracts";
import type { ContextTimeline, FleetDelegation, FleetDetail, FleetDetailCounts, FleetMessage, FleetSummary } from "../shared/core/types";
import { agentReportsOf, delegationTextOf, type CapturedTask, type FleetRecord } from "./collaboration";
import type { ContextService } from "./service";
import { nodeSeq, rowOf, upstreamOf } from "./upstream";
import { parseArgs, text } from "./value";

type Loaded = Awaited<ReturnType<ContextService["load"]>>;
type Mode = "preview" | "history" | "full";
interface MessageSource { data: Loaded; record: FleetRecord; from: string }
export interface FleetTask {
  id: string; subject: string; description: string; status: CapturedTask["status"];
  ownerId?: string; ownerName?: string; blockedBy: string[]; writeScopes: string[]; ready: boolean; warnings: string[];
}
export interface AgentTeam { tasks: FleetTask[]; failure?: string }
export interface FleetRead {
  rootId: string; agents: Agent[]; loaded: Map<string, Loaded>; failed: number; total: number;
}
const PREVIEW_MESSAGES = 80;
const PREVIEW_TEXT = 400;
const clip = (value: string, max: number) => value.length <= max ? value : value.slice(0, max) + "…";
const taskKey = (owner: string, id: string) => `${owner}:task:${id}`;
const identity = (agent: Agent) => `${agent.provider}:${agent.sessionId ?? agent.id}`;

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
  const aliases = new Map<string, string>(), names = new Map<string, string | null>();
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
  return { tasks, ...(family.failed ? { failure: "Some fleet sessions could not be read; captured task state may be incomplete." } : {}) };
}

/** Adds only captured task data; no provider membership/ownership is invented. */
export function fleetRow(agent: Agent, team: AgentTeam, head?: ContextTimeline) {
  const row = rowOf(agent, head);
  return { ...row, projectionValues: { ...row.projectionValues, agentTeam: team } };
}

export class UiFleet {
  constructor(private service: Pick<ContextService, "agent" | "load" | "fleet" | "content">) {}

  async read(id: string, paseo: PaseoApi, seed?: Loaded): Promise<FleetRead> {
    const family = await this.service.fleet(id, paseo), candidates = family.members.map((s) => s.agent);
    if (seed && !candidates.some((a) => a.id === seed.agent.id)) candidates.push(seed.agent);
    const bySession = new Map<string, Agent>();
    for (const agent of candidates) {
      const previous = bySession.get(identity(agent));
      if (!previous || previous.id.startsWith("native:") && !agent.id.startsWith("native:")) bySession.set(identity(agent), agent);
    }
    const agents = [...bySession.values()];
    const root = candidates.find((a) => a.id === family.rootId);
    const rootId = root ? bySession.get(identity(root))!.id : family.rootId;
    const loaded = new Map<string, Loaded>(), failed = new Set<string>();
    await mapBounded(agents, async (agent) => {
      try {
        const data = seed && identity(seed.agent) === identity(agent) ? { ...seed, agent }
          : await this.service.load(await this.service.agent(agent.id, paseo), paseo);
        loaded.set(agent.id, data);
      } catch { failed.add(agent.id); }
    });
    return { rootId, agents, loaded, failed: family.failed + failed.size, total: agents.length + family.failed };
  }
  rows(family: FleetRead) {
    const team = teamOfFleet(family);
    return family.agents.map((agent) => {
      const data = family.loaded.get(agent.id);
      return fleetRow(agent, team, data ? upstreamOf(data).head : undefined);
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
  private async messageText(source: MessageSource, paseo: PaseoApi): Promise<string> {
    const value = await this.service.content(source.data.agent.id, source.record.nodeId, paseo);
    if (source.record.contentKind === "delegation-result") return delegationTextOf(value);
    if (source.record.contentKind === "report") {
      const report = agentReportsOf(value).find((r) => r.from === source.record.from);
      if (!report) throw new Error("Agent report is no longer available");
      return report.text;
    }
    const args = parseArgs(value);
    return text(args.message ?? args.content ?? args.prompt ?? args.description ?? args.subject ?? args.explanation) || value;
  }
  private async nodeText(data: Loaded, nodes: Loaded["fold"]["nodes"], paseo: PaseoApi) {
    return (await mapBounded(nodes, (node) => this.service.content(data.agent.id, node.id, paseo))).join("\n");
  }
  async detail(family: FleetRead, id: string, mode: Mode, paseo: PaseoApi): Promise<FleetDetail | null> {
    const resolve = resolverOf(family);
    const canonicalId = resolve(id, family.agents.find((a) => a.id === family.rootId)?.provider ?? "");
    const data = family.loaded.get(canonicalId);
    if (!data) return null;
    const { incoming } = sourcesOf(family), all = incoming.get(canonicalId) ?? [];
    const shown = mode === "preview" ? all.slice(-PREVIEW_MESSAGES) : all;
    const messages = await mapBounded(shown, async (source): Promise<FleetMessage> => {
      const value = mode === "preview" ? source.record.title : await this.messageText(source, paseo);
      const clipped = mode === "preview" && (value.length > PREVIEW_TEXT || (source.record.textLength ?? value.length) > value.length);
      const fromName = family.agents.find((a) => a.id === source.from)?.title;
      const body = mode === "preview" ? clip(value, PREVIEW_TEXT) : value;
      return { seq: messageSeq(source), time: source.record.time, from: source.from, ...(fromName ? { fromName } : {}),
        kind: source.record.kind === "report" ? "settled" : "relay", text: body,
        ...(source.record.kind === "report" ? { report: body,
          summary: source.record.status === "failed" ? "Agent reported an error." : "Agent completed." } : {}),
        ...(clipped ? { clipped: true } : {}) };
    });
    const first = data.fold.nodes.find((n) => n.category === "user");
    const last = [...data.fold.nodes].reverse().find((n) => n.category === "assistant" && n.gone === undefined);
    const promptNodes = first ? data.fold.nodes.filter((n) => n.category === "user" && n.line === first.line) : [];
    const replyNodes = last ? data.fold.nodes.filter((n) => n.category === "assistant" && n.line === last.line) : [];
    const prompt = first ? mode === "preview" ? clip(promptNodes.map((n) => n.preview).join("\n"), 1600)
      : await this.nodeText(data, promptNodes, paseo) : undefined;
    const reply = last ? mode === "preview" ? clip(replyNodes.map((n) => n.preview).join("\n"), 300)
      : await this.nodeText(data, replyNodes, paseo) : undefined;
    const parent = data.agent.parentId ? family.loaded.get(resolve(data.agent.parentId, data.agent.provider)) : undefined;
    const child = parent && [...parent.fold.collaboration.children.values()].find((c) => c.sessionId === data.agent.sessionId);
    return { descriptor: { mode: child?.mode ?? "continuable", label: data.agent.title,
      agentProvider: data.agent.provider, agentModel: data.summary.agent.model },
      ...(prompt === undefined ? {} : { initialPrompt: prompt }),
      ...(reply === undefined || !last ? {} : { lastReply: { time: last.time, text: reply } }),
      messages, messagesTotal: all.length, delegations: this.delegations(family, data),
      truncated: shown.length < all.length || family.failed > 0 };
  }
  async summary(family: FleetRead, paseo: PaseoApi): Promise<FleetSummary> {
    const { incoming } = sourcesOf(family), counts: Record<string, FleetDetailCounts> = {};
    // Incoming messages can originate in any member. An unread source prevents
    // attesting complete totals even for a recipient whose own log was read.
    if (family.failed === 0) for (const [id, data] of family.loaded) {
      counts[id] = { readAt: data.agent.updatedAt, messagesTotal: incoming.get(id)?.length ?? 0,
        delegationsCount: this.delegations(family, data).length };
    }
    const root = family.agents.find((a) => a.id === family.rootId);
    const detail = await this.detail(family, family.rootId, "preview", paseo);
    if (!detail) throw new Error("Fleet root could not be read");
    return { rootId: family.rootId, ...(root ? { rootCreatedAt: root.createdAt } : {}), detail, counts,
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
    const family = await this.read(id, paseo);
    if (body.summary === true) return { ok: true, value: await this.summary(family, paseo) };
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
