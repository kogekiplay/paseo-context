export interface Stats {
provider: string; source: "session" | "unavailable" | "unsupported"; turns: number; steps: number; inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number; timedOutputTokens: number; modelMs: number; toolMs: number; ttftMs: number; ttftSteps: number; speedKind: "estimated";
}
export function emptyStats(provider: string, source: Stats["source"] = "session"): Stats {
  return {
    provider,
    source,
    turns: 0,
    steps: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    timedOutputTokens: 0,
    modelMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    speedKind: "estimated",
  };
}
