import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Pricing } from "../server/pricing";
import { PublicCache } from "../server/public-cache";
import { emptyUsage } from "../shared/contracts";

test("a new pricing instance uses the cached public catalog without network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-pricing-"));
  const cache = new PublicCache(root);
  const catalog = { openai: { models: { "sample-model": { cost: { input: 2, output: 4 } } } } };
  const fetch = vi.fn(async () => ({ ok: true, json: async () => catalog }));
  vi.stubGlobal("fetch", fetch);
  const first = new Pricing(cache), reopened = new Pricing(cache);
  try {
    await first.refresh();
    await reopened.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reopened.cost("openai", "sample-model", { ...emptyUsage(), input: 1_000_000 })).toBe(2);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31 * 86_400_000);
    expect(await cache.read("pricing")).toBeNull();
  } finally {
    first.clear(); reopened.clear(); await cache.clear();
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
