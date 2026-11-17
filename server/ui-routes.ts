import type { PaseoApi } from "@getpaseo/client";
import { scopeSchema } from "../shared/contracts";
import { assemble } from "../shared/core/assemble";
import { incrementOf } from "../shared/core/increment";
import { contextDeltaOf } from "../shared/core/delta";
import { ContextService, agentOf, listAgents } from "./service";
import { nodeSeq, rowOf, upstreamOf } from "./upstream";
import { count, record, text } from "./value";
import { Metadata } from "./metadata";
import { UiFleet } from "./ui-fleet";
import { uiDocument } from "./assets";
import { imageUrlOf } from "./images";
import { previewFile } from "./files";
import { statisticsOf } from "./statistics";
import { statisticsDetails } from "./statistics-details";

export class UiRoutes {
  private metadata = new Metadata();
  private fleet: UiFleet;
  constructor(private service: ContextService) {
    this.fleet = new UiFleet(service);
    void service.pricing.refresh();
  }
  clear() { this.metadata.clear(); this.fleet.clear(); }
  private async load(id: string, paseo: PaseoApi) {
    const data = await this.service.load(await this.service.agent(id, paseo), paseo);
    return { ...data, ...upstreamOf(data) };
  }
  async handle(route: string, input: unknown, paseo: PaseoApi): Promise<unknown> {
    const body = record(input), id = text(body.sessionId ?? body.agentId);
    if (route === "ui.document") return uiDocument();
    if (route === "ui.error") {
      console.error("[paseo-context] UI error:", text(body.message).slice(0, 16000));
      return true;
    }
    if (route === "ui.status") {
      const phase = text(body.phase).slice(0, 80), platform = text(body.platform).slice(0, 20);
      console.info(`[paseo-context] native UI ${platform}: ${phase}`);
      return true;
    }
    if (route === "bootstrap") {
      const sessions = (await listAgents(paseo)).map((a) => rowOf(agentOf(a)));
      const selected = id ? await this.load(id, paseo) : null;
      if (selected) {
        const family = await this.fleet.read(id, paseo, selected);
        for (const row of this.fleet.rows(family)) {
          const index = sessions.findIndex((a) => a.id === row.id);
          if (index < 0) sessions.push(row); else sessions[index] = row;
        }
      }
      return { sessions, selected: selected ? { head: selected.head, headers: selected.headers,
        ...(body.mode === "statistics" ? { statistics: statisticsOf(selected) } : {}), notices: selected.summary.notices } : null };
    }
    if (route === "family") {
      return this.fleet.rows(await this.fleet.read(id, paseo));
    }
    if (route === "statistics.details") {
      const data = await this.service.load(await this.service.agent(id, paseo), paseo);
      return statisticsDetails(data, text(body.requestId), this.service.content.bind(this.service), paseo);
    }
    if (route === "history.page") {
      const data = await this.load(text(record(body.address).sessionId ?? record(body.address).childSessionId), paseo);
      const seq = count(body.throughSeq), epoch = data.fold.toolEpochs.find((epoch) => epoch.seq === seq);
      if (epoch) {
        const tools = await Promise.all(epoch.nodeIds.map(async (nodeId) => {
          const content = await this.service.content(data.agent.id, nodeId, paseo);
          try { return JSON.parse(content); } catch { return { name: data.fold.nodes[nodeId].title, description: content }; }
        }));
        return { records: [{ event: { type: "request/header", seq, data: { header: { tools } } } }] };
      }
      const node = data.fold.nodes.find((node) => nodeSeq(data.fold, node.id) === seq);
      if (!node) return { records: [] };
      const command = data.fold.commands.find((command) => command.outputNode === node.id);
      const content = command?.outputNodes && command.outputNodes.length > 1
        ? (await Promise.all(command.outputNodes.map((id) => this.service.content(data.agent.id, id, paseo)))).join("\n")
        : await this.service.content(data.agent.id, node.id, paseo);
      const records: unknown[] = [];
      const ev = (type: string, data: unknown) => ({ event: { type, seq, data } });
      const image = node.images ? { type: "image", attachment: { attachmentId: `paseo-context-image:${node.id}`, name: "Image" } } : null;
      if (node.category === "system") records.push(ev("system/message", { message: { content: [{ type: "text", text: content }] } }));
      else if (node.category === "tools") {
        let tool: unknown; try { tool = JSON.parse(content); } catch { tool = { name: node.title, description: content }; }
        records.push(ev("request/header", { header: { tools: [tool] } }));
      } else if (node.category === "tool" || node.category === "skill") {
        const call = command ? data.fold.nodes[command.id] : data.fold.nodes.find((n) => n.callId === node.callId && n.category === "calls");
        const callId = call?.callId ?? node.callId;
        if (call) records.push({ event: { type: "tool/call", seq: nodeSeq(data.fold, call.id), data: {
          callId, name: call.tool, arguments: await this.service.content(data.agent.id, call.id, paseo),
        } } });
        records.push(ev("tool/result", { message: { toolCallId: callId, isError: command?.status === "failed", content: [{ type: "text", text: content }] } }));
      } else if (node.category === "assistant" || node.category === "reasoning" || node.category === "calls") {
        records.push(ev("assistant/message", { message: { content: [image ?? (node.category === "calls"
          ? { type: "tool-call", name: node.tool, arguments: content }
          : { type: node.category === "reasoning" ? "reasoning" : "text", text: content })] } }));
      } else records.push(ev("user/message", { content: [image ?? { type: "text", text: content }] }));
      return { records };
    }
    const name = route.replace(/^api\/paseo-context\//, "");
    if (name === "version") return { ok: true, value: await this.metadata.version() };
    if (name === "balance") return { ok: true, value: await this.metadata.balance() };
    if (name === "backfill") return { ok: true, value: await this.service.backfill(paseo) };
    if (name === "recom") return { ok: true, value: await this.metadata.recoms() };
    if (name === "file.preview") {
      const data = await this.load(id, paseo);
      return previewFile(data.agent, data.fold.files, text(body.path));
    }
    if (name === "image") {
      if (!id) throw new Error("An agent is required");
      const match = /^paseo-context-image:(\d+)$/.exec(text(body.attachmentId));
      if (!match) throw new Error("Unknown image");
      const url = imageUrlOf(await this.service.content(id, Number(match[1]), paseo));
      if (!url) throw new Error("Image bytes were not retained in this session");
      return url;
    }
    if (name === "skills") {
      if (!id) return { ok: true, value: { skills: [] } };
      const commands = await paseo.agents.ref(id).commands();
      return { ok: true, value: { skills: commands.commands.filter((c) => c.kind === "skill").map((c) => ({ name: c.name, description: c.description })) } };
    }
    if (name === "overview") return this.overview(body, paseo);
    if (name === "heads") {
      const out: Record<string, unknown> = {};
      for (const id of Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string").slice(0, 64) : []) {
        try { out[id] = { head: (await this.load(id, paseo)).head }; } catch {}
      }
      return { ok: true, value: out };
    }
    if (name === "fleet") return this.fleet.handle(body, paseo);
    if (!id) throw new Error("An agent is required for this context request");
    const data = await this.load(id, paseo), { head, headers } = data;
    const rev = head.detailRev ?? 0;
    if (name === "snapshot") return { ok: true, value: head };
    if (name === "detail") return { ok: true, value: { ...head, head, rev } };
    if (name === "facts") {
      const wanted = Array.isArray(body.parts) ? body.parts : ["head", "series"];
      const parts: Record<string, unknown> = {};
      for (const part of wanted) {
        if (part === "head") parts.head = head;
        else if (part === "series" || part === "requests") parts[part] = head.requests;
        else if (part === "nodes") parts.nodes = { nodes: head.nodes, archive: head.archive, droppedNodes: 0 };
        else if (part === "events") parts.events = head.events;
        else if (part === "files") parts.files = { fileOps: head.fileOps ?? [] };
        else if (part === "commands") parts.commands = { commands: head.commands ?? [], commandStats: head.commandStats };
        else if (part === "spans") parts.spans = head.spans ?? [];
      }
      return { ok: true, value: { rev, live: true, parts } };
    }
    if (name === "delta") {
      const selected = body.seq === null ? null : count(body.seq), base = body.baseSeq === null ? null : count(body.baseSeq);
      const view = assemble(head, headers, selected), previous = assemble(head, headers, base);
      return { ok: true, value: contextDeltaOf(incrementOf(view, previous), view) };
    }
    if (name === "commands") {
      const before = typeof body.beforeSeq === "number" ? body.beforeSeq : Infinity;
      const rows = (head.commands ?? []).filter((c) => c.seq < before);
      return { ok: true, value: { commands: rows.slice(-100), total: rows.length, atStart: rows.length <= 100 } };
    }
    throw new Error(`Unsupported Paseo Context route: ${route}`);
  }
  private async overview(body: Record<string, unknown>, paseo: PaseoApi) {
    const raw = record(body.scope), range = raw.range;
    const date = (n: number) => { const d = new Date(n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    const pick = record(body.pick), field = text(pick.field), tally = text(body.tally);
    const scope = scopeSchema.parse({ range: typeof range === "object" ? "custom" : range || "30d",
      start: typeof range === "object" ? date(count(record(range).start)) : "",
      end: typeof range === "object" ? date(count(record(range).end)) : "",
      day: text(raw.day), coverage: raw.coverage || "all", group: text(raw.group), query: text(raw.query), sort: body.sort || "recent",
      pick: field === "cmds" ? "programs" : field, name: text(pick.name),
    });
    const index = count(body.page), data = await this.service.overview(scope, index * 24, paseo), revision = String(Math.floor(Date.now() / 10000));
    const part = text(body.part), pricingReady = true;
    const tokenParts = Object.entries(data.parts).map(([key, value]) => ({ key: key === "reasoning" ? "thinking" : key === "assistant" ? "answers" : key === "calls" ? "toolCalls" : key, value }));
    if (part === "days") return { ok: true, value: { revision, pricingReady, days: data.days.map((d) => ({ key: d.day, tokens: d.tokens, sessions: d.sessions, costUsd: d.costUsd })) } };
    if (part === "summary") return { ok: true, value: { revision, pricingReady, summary: {
      sessions: data.total, sessionsTotal: data.scanned, sessionsArchived: data.sessionsArchived, archivedScoped: data.archivedScoped,
      tokens: data.tokens, turns: data.turns, costUsd: data.costUsd, costSessions: data.costSessions,
      usageSessions: data.usageSessions, cacheHit: data.input > 0 ? (data.cacheRead / data.input * 100).toFixed(1) : null,
      tokenParts, timing: data.timing, windowTiming: { calls: data.calls, toolCalls: data.toolCalls, toolsMs: data.toolsMs, wallMs: data.wallMs },
      coverage: { complete: data.failed === 0, remaining: 0, failed: data.failed, running: false, total: data.scanned, covered: data.scanned - data.failed, unsupported: 0 },
    } } };
    if (part === "tally") {
      const items = tally === "cmds" ? data.programs : tally === "skills" ? data.skills : data.tools;
      const sessions = data.tallySessionCounts[tally === "cmds" ? "programs" : tally === "skills" ? "skills" : "tools"];
      return { ok: true, value: { revision, pricingReady, tally: { field: tally, stats: items.map((t) => ({ name: t.name, n: t.count, sessions: sessions[t.name] ?? 0, last: t.last })) } } };
    }
    return { ok: true, value: { revision, pricingReady, page: {
      index, count: Math.max(1, Math.ceil(data.total / 24)), total: data.total, scopeTotal: data.total,
      groups: data.groupCounts,
      items: data.sessions.map((s) => ({ id: s.agent.id, title: s.agent.title, cwd: s.agent.cwd, updatedAt: s.agent.updatedAt,
        running: s.agent.running, archived: s.agent.archived, group: s.agent.cwd,
        tokens: s.usage.input + s.usage.output, turns: s.turns, steps: s.steps, parts: Object.entries(currentOfSummary(s)).map(([key, value]) => ({ key, value })),
        total: Object.values(s.parts).reduce((a, b) => a + b, 0), contextWindow: s.contextWindow ?? undefined,
        model: s.agent.model, costUsd: s.costUsd, createdDay: date(s.agent.createdAt) })),
    } } };
  }
}
function currentOfSummary(s: Awaited<ReturnType<ContextService["summary"]>>) {
  return { system: s.parts.system, tools: s.parts.tools, user: s.parts.user, inject: s.parts.inject, skill: s.parts.skill,
    assistant: s.parts.assistant + s.parts.reasoning + s.parts.calls, tool: s.parts.tool };
}
