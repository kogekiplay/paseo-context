import type { ContextTimeline, TokenUsage } from "./core/types";

/** Absence means unavailable; a captured provider report containing zero stays zero. */
export function reportedUsageOf(head: Pick<ContextTimeline, "cost">): TokenUsage | null {
  if (!head.cost) return null;
  const total = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const models of Object.values(head.cost)) for (const model of Object.values(models)) {
    for (const bucket of [model.off, model.peak]) {
      if (!bucket) continue;
      total.uncachedInputTokens += bucket.uncached; total.outputTokens += bucket.output;
      total.cacheReadTokens += bucket.cacheRead; total.cacheWriteTokens += bucket.cacheWrite;
    }
  }
  return total;
}
