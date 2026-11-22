import type { ContextNode } from "../shared/contracts";
import { stringBytes, stringIndexBytes } from "./value";

export interface StatisticsSpan {
  id: string; turn: number; start: number; boundary: number; endBoundary: number | null;
  rawTurn: number; nodeIds: number[];
  lastAt: number;
  end: number | null; requestId?: string; responseKey?: string; prompt: string;
  closed: boolean; interrupted: boolean; aborted: boolean;
}

/** Step identity is independent of usage: interrupted and live requests survive. */
export class StatisticsSpans {
  readonly rows: StatisticsSpan[] = [];
  private current: StatisticsSpan | undefined;
  private responses = new Map<string, StatisticsSpan>();
  private requests = new Map<string, StatisticsSpan>();
  private byId = new Map<string, StatisticsSpan>();
  private lastUsageAt = 0;
  get residentBytes() {
    let bytes = 320 + stringIndexBytes(this.byId.keys()) + stringIndexBytes(this.requests.keys()) + stringIndexBytes(this.responses.keys());
    for (const row of this.rows) bytes += 224 + stringBytes(row.prompt) + row.nodeIds.length * 8;
    return bytes;
  }
  find(id: string) { return this.byId.get(id) ?? this.requests.get(id); }
  observe(input: {
    line: number; turn: number; at: number; firstNode: number; nodes: readonly ContextNode[];
    requestId?: string; responseKey?: string; turnStart: boolean; close?: "complete" | "abort" | "interrupt";
  }) {
    const { at, nodes, firstNode, responseKey, requestId } = input;
    const output = nodes.some((node) => ["assistant", "reasoning", "calls"].includes(node.category));
    const user = nodes.find((node) => node.category === "user");
    const existing = (responseKey ? this.responses.get(responseKey) : undefined) ?? (requestId ? this.requests.get(requestId) : undefined);
    const trailing = at >= this.lastUsageAt && at - this.lastUsageAt <= 100;
    const newTurn = this.current && (input.turn !== this.current.rawTurn || (user && (this.current.requestId || this.current.closed)));
    const newResponse = !existing && output && this.current && (this.current.closed
      || (responseKey && this.current.responseKey && responseKey !== this.current.responseKey)
      || (this.current.requestId && !trailing));
    if (!existing && (newTurn || newResponse || requestId && this.current?.requestId && this.current.requestId !== requestId)) {
      this.finish(firstNode, at);
    }
    if (!existing && !this.current && (input.turnStart || user || output || requestId)) {
      this.current = { id: `step:${input.line}`, turn: Math.max(1, input.turn), rawTurn: input.turn, nodeIds: [], start: at, lastAt: at,
        boundary: firstNode, endBoundary: null, end: null, prompt: user?.preview ?? "",
        closed: false, interrupted: false, aborted: false };
      this.rows.push(this.current);
      this.byId.set(this.current.id, this.current);
    }
    const span = existing ?? this.current;
    if (!span) return;
    span.nodeIds.push(...nodes.map((node) => node.id));
    if (nodes.length || requestId && !existing) span.lastAt = Math.max(span.lastAt, at);
    if (user && !span.prompt) span.prompt = user.preview;
    if (responseKey) { span.responseKey = responseKey; this.responses.set(responseKey, span); }
    if (requestId) {
      if (!span.requestId && span === this.current) this.lastUsageAt = at;
      span.requestId = requestId; this.requests.set(requestId, span);
    }
    if (input.close) {
      span.end = at; span.closed = true;
      span.aborted = input.close === "abort"; span.interrupted = input.close === "interrupt";
    }
  }
  private finish(boundary: number, at: number) {
    if (this.current) {
      this.current.endBoundary = boundary;
      this.current.end ??= this.current.lastAt || at;
      this.current.closed = true;
    }
    this.current = undefined;
  }
}
