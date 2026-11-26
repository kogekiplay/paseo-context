import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { expect, test, vi } from "vitest";
import { Pricing } from "../server/pricing";
import { PublicCache } from "../server/public-cache";
import { MAX_PUBLIC_JSON_BYTES, readPublicJson } from "../server/bounded-json";
import { Metadata } from "../server/metadata";
import { emptyUsage } from "../shared/contracts";
import { RECOM_DATA_URL, recomsOfPayload } from "../shared/core/recoms";
import { recommendations } from "../shared/recommendations";

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
    await expect(metadata.recoms()).resolves.toMatchObject({ degraded: true, recoms: recommendations });
  } finally { pricing.clear(); metadata.clear(); vi.unstubAllGlobals(); }
});

test.each([
  { status: 404, failed: false },
  { status: 500, failed: true },
])("cancels the unread body of an HTTP $status metadata response", async ({ status, failed }) => {
  const metadata = new Metadata();
  const response = new Response("Upstream error", { status });
  const cancel = vi.spyOn(response.body!, "cancel");
  vi.stubGlobal("fetch", vi.fn(async () => response));
  try {
    await expect(metadata.version()).resolves.toMatchObject({ failed });
    expect(cancel).toHaveBeenCalledOnce();
  } finally { metadata.clear(); vi.unstubAllGlobals(); }
});

test("the validated upstream recommendations match the offline fallback and survive a cache reopen", async () => {
  const catalog = JSON.parse(await readFile(new URL("../data/recoms.json", import.meta.url), "utf8"));
  expect(recommendations).toEqual(catalog);
  expect(recomsOfPayload(catalog)).toEqual(recommendations);

  const root = await mkdtemp(join(tmpdir(), "paseo-recommendations-"));
  const cache = new PublicCache(root);
  const first = new Metadata(cache), reopened = new Metadata(cache);
  const fetch = vi.fn(async () => Response.json(catalog));
  vi.stubGlobal("fetch", fetch);
  try {
    const expected = { recoms: recommendations, degraded: false };
    await expect(first.recoms()).resolves.toMatchObject(expected);
    await expect(reopened.recoms()).resolves.toMatchObject(expected);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(RECOM_DATA_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  } finally {
    first.clear(); reopened.clear(); await cache.clear();
    vi.unstubAllGlobals();
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
