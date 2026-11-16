import { calculateSessionCost, pricesBookOf, type ModelBook } from "../shared/core/pricing";
import type { Request, Usage } from "../shared/contracts";

export class Pricing {
  revision = 0;
  private book: ModelBook | null = null;
  private fetchedAt = 0;
  private busy: Promise<void> | null = null;
  private controller: AbortController | null = null;
  async refresh() {
    if (Date.now() - this.fetchedAt < 3_600_000) return;
    if (this.busy) return this.busy;
    this.controller = new AbortController();
    const timer = setTimeout(() => this.controller?.abort(), 8000);
    this.busy = (async () => {
      try {
        const response = await fetch("https://models.dev/api.json", { signal: this.controller!.signal });
        if (!response.ok) throw new Error(`Pricing HTTP ${response.status}`);
        const book = pricesBookOf(await response.json());
        if (book) { this.book = book; this.revision++; }
        this.fetchedAt = Date.now();
      } catch { this.fetchedAt = Date.now() - 3_540_000; }
      finally { clearTimeout(timer); this.busy = null; this.controller = null; }
    })();
    return this.busy;
  }
  cost(provider: string, model: string, usage: Usage) {
    if (usage.input + usage.output === 0) return 0;
    return calculateSessionCost({ [provider]: { [model]: { off: {
      uncached: Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite),
      cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output,
    } } } }, this.book);
  }
  priceRequests(provider: string, requests: Request[]) {
    return requests.map((r) => ({ ...r, costUsd: this.cost(provider, r.model, r.usage) }));
  }
  clear() { this.controller?.abort(); this.book = null; }
}
