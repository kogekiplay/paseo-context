import { call } from "./bridge";

const BACKOFF_MS = 5000;
const MAX_BACKOFF_ENTRIES = 128;
const inflight = new Map<string, Promise<{ default: unknown }>>();
const failedUntil = new Map<string, number>();

/** JSON grammar data, never executable downloaded code. */
export function loadGrammar(name: string): Promise<{ default: unknown }> {
  const retryAt = failedUntil.get(name);
  if (retryAt !== undefined) {
    if (Date.now() < retryAt) return Promise.reject(new Error(`Grammar "${name}" temporarily backed off`));
    failedUntil.delete(name);
  }
  const existing = inflight.get(name);
  if (existing) return existing;
  const request = call("ui.grammar", { name })
    .then((grammar) => ({ default: grammar }))
    .catch((error) => {
      failedUntil.delete(name);
      failedUntil.set(name, Date.now() + BACKOFF_MS);
      while (failedUntil.size > MAX_BACKOFF_ENTRIES) failedUntil.delete(failedUntil.keys().next().value!);
      throw error;
    })
    .finally(() => { inflight.delete(name); });
  inflight.set(name, request);
  return request;
}
