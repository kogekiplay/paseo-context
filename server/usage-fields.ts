import { emptyUsage, type Usage } from "../shared/contracts";
import type { UsageSource, UsageSources } from "../shared/core/types";
import { record } from "./value";

export const usageKeys = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const;

function token(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// Keep the raw input lane separate so a sparse Claude block can update any
// lane without erasing the others or repeatedly adding cache tokens to input.
export function usageBuckets(value: unknown, provider: "codex" | "claude"): Partial<Usage> {
  const raw = record(value);
  const claude = provider === "claude";
  const buckets = {
    input: token(raw.input_tokens),
    cacheRead: claude ? token(raw.cache_read_input_tokens) : token(raw.cached_input_tokens) ?? token(raw.cache_read_input_tokens),
    cacheWrite: token(claude ? raw.cache_creation_input_tokens : raw.cache_write_input_tokens),
    output: token(raw.output_tokens),
    reasoning: token(claude ? raw.reasoning_tokens : raw.reasoning_output_tokens),
  };
  return Object.fromEntries(usageKeys.flatMap((key) => buckets[key] === undefined ? [] : [[key, buckets[key]]]));
}

export function requestUsage(buckets: Partial<Usage>, provider: "codex" | "claude"): Usage {
  const usage = { ...emptyUsage(), ...buckets };
  if (provider === "claude" && buckets.input !== undefined) usage.input += usage.cacheRead + usage.cacheWrite;
  return usage;
}

export function sourcesOfUsage(buckets: Partial<Usage>, source: UsageSource): UsageSources {
  return Object.fromEntries(usageKeys.flatMap((key) => buckets[key] === undefined ? [] : [[key, source]]));
}

export function cumulativeDelta(current: Partial<Usage>, previous: Partial<Usage> | null): Partial<Usage> {
  const reset = previous && (["input", "output"] as const).some((key) => {
    const value = current[key], base = previous[key];
    return value !== undefined && base !== undefined && value < base;
  });
  const delta: Partial<Usage> = {};
  for (const key of usageKeys) {
    const value = current[key], base = !previous || reset ? 0 : previous[key];
    if (value !== undefined && base !== undefined && value >= base) delta[key] = value - base;
  }
  return delta;
}
