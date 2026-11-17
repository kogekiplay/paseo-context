import type { PaseoApi } from "@getpaseo/client";
import { record, text } from "./value";

export interface PaseoSubtask {
  callId: string; childId?: string; subject: string; description: string;
  status: "in_progress" | "completed" | "failed" | "canceled";
}
const MAX_AGENTS = 128, TTL = 5000;

/** Reads the same sub_agent timeline facts that Paseo displays as Subtasks. */
export class PaseoSubtasks {
  private cache = new Map<string, { at: number; revision: number; tasks: PaseoSubtask[] }>();
  private pending = new Map<string, Promise<PaseoSubtask[]>>();
  private closed = false;
  read(agentId: string, revision: number, paseo: PaseoApi): Promise<PaseoSubtask[]> {
    if (this.closed) return Promise.reject(new Error("Plugin was stopped"));
    const cached = this.cache.get(agentId);
    if (cached && cached.revision === revision && Date.now() - cached.at < TTL) return Promise.resolve(cached.tasks);
    const pending = this.pending.get(agentId);
    if (pending) return pending;
    const read = this.fetch(agentId, paseo).then((tasks) => {
      if (!this.closed) {
        this.cache.delete(agentId); this.cache.set(agentId, { at: Date.now(), revision, tasks });
        while (this.cache.size > MAX_AGENTS) this.cache.delete(this.cache.keys().next().value!);
      }
      return tasks;
    }).finally(() => { this.pending.delete(agentId); });
    this.pending.set(agentId, read);
    return read;
  }
  private async fetch(agentId: string, paseo: PaseoApi): Promise<PaseoSubtask[]> {
    const tasks = new Map<string, PaseoSubtask>();
    let cursor, epoch: string | undefined;
    const seen = new Set<string>();
    do {
      if (this.closed) throw new Error("Plugin was stopped");
      const page = await paseo.agents.ref(agentId).timeline.refetch({
        direction: cursor ? "before" : "tail", limit: 200, ...(cursor ? { cursor } : {}),
      });
      if (page.error) throw new Error(page.error);
      if (epoch !== undefined && page.epoch !== epoch) throw new Error("Subtask timeline changed while reading history");
      epoch = page.epoch;
      // Pages arrive newest first. Retain only task facts, and never let an
      // older running version replace a terminal version from a newer page.
      for (const entry of [...page.entries].reverse()) {
        const item = record(entry.item), detail = record(item.detail);
        const callId = text(item.callId);
        if (item.type !== "tool_call" || detail.type !== "sub_agent" || !callId || tasks.has(callId)) continue;
        const status = item.status === "running" ? "in_progress"
          : item.status === "completed" || item.status === "failed" || item.status === "canceled" ? item.status : null;
        if (!status) continue;
        const description = text(detail.description), childId = text(detail.childSessionId);
        tasks.set(callId, { callId, subject: description.slice(0, 180) || text(item.name),
          description: description.slice(0, 16000), status, ...(childId ? { childId } : {}) });
      }
      if (page.hasOlder && !page.startCursor) throw new Error("Subtask timeline omitted its history cursor");
      cursor = page.hasOlder ? page.startCursor ?? undefined : undefined;
      const key = JSON.stringify(cursor);
      if (cursor && seen.has(key)) throw new Error("Subtask timeline returned a repeated cursor");
      if (cursor) seen.add(key);
    } while (cursor);
    if (this.closed) throw new Error("Plugin was stopped");
    return [...tasks.values()];
  }
  clear() { this.closed = true; this.cache.clear(); this.pending.clear(); }
}
