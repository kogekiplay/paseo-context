import { calculateSessionCost, pricesBookOf, priceSourceOf, type ModelBook } from "../shared/core/pricing";
import type { Request, Usage } from "../shared/contracts";
import { usageSourceOf } from "../shared/usage";
import type { PublicCache } from "./public-cache";
import { readPublicJson } from "./bounded-json";

export class Pricing {
  constructor(private cache?: PublicCache) {}
  revision = 0;
  private book: ModelBook | null = null;
  private fetchedAt = 0;
  private busy: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private cacheLoaded = false;
  private closed = false;
  async refresh() {
    if (this.closed || Date.now() - this.fetchedAt < 3_600_000) return;
    if (this.busy) return this.busy;
    const pending = this.busy = this.load();
    try { await pending; } finally { this.busy = null; }
  }
  private async load() {
    if (this.cache && !this.cacheLoaded) {
      this.cacheLoaded = true;
      const cached = await this.cache.read("pricing");
      if (this.closed) return;
      const book = cached && pricesBookOf(cached.value);
      if (cached && book && Object.keys(book.prices).length) {
        this.book = book; this.revision++; this.fetchedAt = cached.at;
        if (Date.now() - cached.at < 3_600_000) return;
      }
    }
    const controller = this.controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    timer.unref();
    try {
      const response = await fetch("https://models.dev/api.json", { signal: controller.signal });
      if (!response.ok) throw new Error(`Pricing HTTP ${response.status}`);
      const source = priceSourceOf(await readPublicJson(response));
      const book = pricesBookOf(source);
      if (!source || !book || !Object.keys(book.prices).length) throw new Error("Invalid price catalog");
      if (this.closed) return;
      this.book = book; this.revision++; this.fetchedAt = Date.now();
      await this.cache?.write("pricing", source, this.fetchedAt);
    } catch { this.fetchedAt = Date.now() - 3_540_000; }
    finally { clearTimeout(timer); this.controller = null; }
  }
  cost(provider: string, model: string, usage: Usage) {
    if (usage.cacheRead + usage.cacheWrite > usage.input) return null;
    if (usage.input + usage.output === 0) return 0;
    return calculateSessionCost({ [provider]: { [model]: { off: {
      uncached: Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite),
      cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output,
    } } } }, this.book);
  }
  priceRequests(provider: string, requests: Request[]) {
    return requests.map((r) => ({
      ...r,
      costUsd: usageSourceOf(r, "input") && usageSourceOf(r, "output") ? this.cost(provider, r.model, r.usage) : null,
    }));
  }
  clear() { this.closed = true; this.controller?.abort(); this.book = null; }
}
