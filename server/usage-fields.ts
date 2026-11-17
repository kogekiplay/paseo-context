import type { Usage } from "../shared/contracts";
import { record } from "./value";

export function usageFields(value: unknown, provider: string): (keyof Usage)[] {
  const raw = record(value);
  const valid = (key: string) => typeof raw[key] === "number" && Number.isFinite(raw[key]) && (raw[key] as number) >= 0;
  const fields: (keyof Usage)[] = [];
  if (valid("input_tokens")) fields.push("input");
  if (valid("output_tokens")) fields.push("output");
  if (provider === "claude") {
    if (valid("cache_read_input_tokens")) fields.push("cacheRead");
    if (valid("cache_creation_input_tokens")) fields.push("cacheWrite");
    if (valid("reasoning_tokens")) fields.push("reasoning");
  } else {
    if (valid("cached_input_tokens") || valid("cache_read_input_tokens")) fields.push("cacheRead");
    if (valid("cache_write_input_tokens")) fields.push("cacheWrite");
    if (valid("reasoning_output_tokens")) fields.push("reasoning");
  }
  return fields;
}
