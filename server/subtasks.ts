import type { PaseoApi } from "@getpaseo/client";
import { ensureActive, timelineHistory } from "./paging";
import { record, text } from "./value";

export interface PaseoSubtask {
  callId: string; childId?: string; subject: string; description: string;
  status: "in_progress" | "completed" | "failed" | "canceled";
}
const MAX_AGENTS = 128, MAX_BYTES = 8 * 1024 * 1024, TTL = 5000;

/** Reads the same sub_agent timeline facts that Paseo displays as Subtasks. */
export class PaseoSubtasks {
  private cache = new Map<string, { at: number; revision: number; tasks: PaseoSubtask[]; bytes: number }>();
  private pending = new Map<string, Promise<PaseoSubtask[]>>();
  private lifetime = new AbortController();
  read(agentId: string, revision: number, paseo: PaseoApi): Promise<PaseoSubtask[]> {
    const signal = this.lifetime.signal;
    if (signal.aborted) return Promise.reject(new Error("Plugin was stopped"));
    const cached = this.cache.get(agentId);
    if (cached && cached.revision === revision && Date.now() - cached.at < TTL) return Promise.resolve(cached.tasks);
    const key = JSON.stringify([agentId, revision]);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const read = this.fetch(agentId, paseo).then((tasks) => {
      const current = this.cache.get(agentId);
      if (!signal.aborted && (!current || current.revision <= revision)) {
        const bytes = tasks.reduce((n, task) => n + 160 + 2 * (task.subject.length + task.description.length + task.callId.length + (task.childId?.length ?? 0)), 0);
        this.cache.delete(agentId);
        if (bytes <= MAX_BYTES) this.cache.set(agentId, { at: Date.now(), revision, tasks, bytes });
        let total = [...this.cache.values()].reduce((n, value) => n + value.bytes, 0);
        for (const [key, value] of this.cache) {
          if (this.cache.size <= MAX_AGENTS && total <= MAX_BYTES && Date.now() - value.at < TTL) break;
          this.cache.delete(key);
          total -= value.bytes;
        }
      }
      return tasks;
    }).finally(() => { if (this.pending.get(key) === read) this.pending.delete(key); });
    this.pending.set(key, read);
    return read;
  }
  private async fetch(agentId: string, paseo: PaseoApi): Promise<PaseoSubtask[]> {
    const tasks = new Map<string, PaseoSubtask>();
    const signal = this.lifetime.signal;
    for await (const page of timelineHistory(paseo.agents.ref(agentId).timeline, signal)) {
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
    }
    ensureActive(signal);
    return [...tasks.values()];
  }
  clear() { this.lifetime.abort(); this.cache.clear(); this.pending.clear(); }
}
