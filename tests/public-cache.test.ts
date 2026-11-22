import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

test("serializes publishers sharing a cache key and preserves the freshest readable version", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-catalog-"));
  const writer = new PublicCache(root), other = new PublicCache(root);
  const now = Date.now();
  try {
    await writeFile(join(root, "pricing-v1.json"), JSON.stringify({ at: now - 4_000, value: "legacy" }));
    await expect(writer.read("pricing")).resolves.toMatchObject({ value: "legacy" });
    await Promise.all([
      writer.write("pricing", "old", now - 3_000),
      other.write("pricing", "new", now - 1_000),
      writer.write("pricing", "late stale", now - 2_000),
      other.write("recommendations", ["keep separate"], now - 2_000),
    ]);
    await expect(other.read("pricing")).resolves.toEqual({ at: now - 1_000, value: "new" });
    await expect(writer.read("recommendations")).resolves.toMatchObject({ value: ["keep separate"] });
    const files = await readdir(root);
    expect(files.filter((file) => file.startsWith("pricing-v2"))).toHaveLength(1);
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  } finally {
    await Promise.all([writer.clear(), other.clear()]);
    await rm(root, { recursive: true, force: true });
  }
});
