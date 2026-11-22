import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Pricing } from "../server/pricing";
import { PublicCache } from "../server/public-cache";
import { MAX_PUBLIC_JSON_BYTES, readPublicJson } from "../server/bounded-json";
import { Metadata } from "../server/metadata";
import { emptyUsage } from "../shared/contracts";

test("a new pricing instance uses the cached public catalog without network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-pricing-"));
  const cache = new PublicCache(root);
  const catalog = { openai: { models: { "sample-model": { cost: { input: 2, output: 4 } } } } };
  const fetch = vi.fn(async () => new Response(JSON.stringify(catalog)));
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

test("rejects oversized headers and streamed JSON before decoding, including misleading content lengths", async () => {
  const streamed = (body: ReadableStream, size: number) => new Response(body as unknown as ConstructorParameters<typeof Response>[0],
    { headers: { "content-length": String(size) } });
  const canceled = vi.fn();
  const oversized = streamed(new ReadableStream({ cancel: canceled }), MAX_PUBLIC_JSON_BYTES + 1);
  await expect(readPublicJson(oversized)).rejects.toThrow("8 MiB limit");
  expect(canceled).toHaveBeenCalledOnce();

  const chunk = new Uint8Array(MAX_PUBLIC_JSON_BYTES / 2).fill(32);
  const aborted = vi.fn();
  const streaming = streamed(new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.enqueue(Uint8Array.of(32));
    },
    cancel: aborted,
  }), 10);
  await expect(readPublicJson(streaming)).rejects.toThrow("8 MiB limit");
  expect(aborted).toHaveBeenCalledOnce();
  await expect(readPublicJson(new Response("\ufeff{\"valid\":true}"))).resolves.toEqual({ valid: true });
});

test("falls back when a provider advertises an oversized public catalog", async () => {
  const pricing = new Pricing(), metadata = new Metadata();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: {
    "content-length": String(MAX_PUBLIC_JSON_BYTES + 1),
  } })));
  try {
    await pricing.refresh();
    expect(pricing.revision).toBe(0);
    await expect(metadata.version()).resolves.toMatchObject({ failed: true });
    await expect(metadata.recoms()).resolves.toMatchObject({ degraded: true });
  } finally { pricing.clear(); metadata.clear(); vi.unstubAllGlobals(); }
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
