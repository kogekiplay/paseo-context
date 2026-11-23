import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { expect, test, vi } from "vitest";
import { ContextService } from "../server/service";
import { SessionReader } from "../server/reader";
import { scopeSchema } from "../shared/contracts";
import { ContextFold } from "../server/fold";

function fixture(size = 5) {
  const agents = Array.from({ length: size }, (_, i) => ({ id: `a${i}`, title: `A${i}`, labels: {}, cwd: "/demo",
    provider: "codex", status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })) as unknown as PaseoAgent[];
  let finish: () => void;
  const delayed = new Promise<void>((resolve) => { finish = resolve; });
  const list = vi.fn(async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false } }));
  const refetch = vi.fn(async (id: string) => {
    if (id === "a0") await delayed;
    return { entries: [], pageInfo: { hasMore: false } };
  });
  const paseo = { agents: { list, ref: (id: string) => ({ timeline: { refetch: () => refetch(id) } }) } } as unknown as PaseoApi;
  const service = new ContextService(new SessionReader());
  service.pricing.refresh = async () => {};
  return { service, paseo, list, refetch, finish: () => finish() };
}

test("shares an aggregation across pages, reuses unchanged ledgers, and expires idle insights", async () => {
  vi.useFakeTimers();
  const { service, paseo, list, refetch, finish } = fixture(30);
  const scope = scopeSchema.parse({ range: "all" });
  finish();
  try {
    const first = await service.overviewForScreen(scope, 0, paseo, "");
    const second = await service.overviewForScreen(scope, 24, paseo, "");
    expect(second.data?.sessions).toHaveLength(6);
    expect(first.data?.sessions).toHaveLength(24);
    expect(second.data?.sessions[0]).not.toBe(first.data?.sessions[0]);
    expect(second.data?.groupCounts).toBe(first.data?.groupCounts);
    expect(second.data?.projects).toBe(first.data?.projects);
    expect(service["overviewCache"].size).toBe(1);
    await service.backfill(paseo);
    const refreshed = await service.overviewForScreen(scope, 0, paseo, "");
    expect(refreshed.data?.sessions[0]).toBe(first.data?.sessions[0]);
    expect(refetch).toHaveBeenCalledTimes(30);
    expect(service["scanning"]).toBeNull();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(service["corpus"]).toBeNull();
    expect(service["overviewCache"].size).toBe(0);
    expect(service["summaries"].peek("a0")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await service.overview(scope, 0, paseo);
    expect(list).toHaveBeenCalledTimes(3);
    expect(refetch).toHaveBeenCalledTimes(60);
  } finally { service.clear(); vi.useRealTimers(); }
});

test("replaces only changed session shards and refreshes costs after a pricing revision", async () => {
  const now = new Date(2026, 10, 23, 12).toISOString();
  const agents = ["one", "two"].map((id) => ({ id, title: id, labels: {}, provider: "codex", cwd: "/demo", status: "idle",
    createdAt: now, updatedAt: now } as PaseoAgent));
  const entries = new Map(agents.map((agent) => [agent.id, { fold: new ContextFold("codex") }]));
  const one = entries.get("one")!.fold, two = entries.get("two")!.fold;
  const response = (fold: ContextFold, id: string, input: number, cache: number, output: number) =>
    fold.apply({ type: "token_usage_record", timestamp: now, payload: { response_id: id,
      usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cache } } });
  response(one, "r1", 100, 50, 10);
  response(two, "r2", 200, 60, 20);
  const paseo = { agents: { list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false } }) } } as unknown as PaseoApi;
  const read = vi.fn(async ({ id }: { id: string }) => ({ entry: entries.get(id)! }));
  const service = new ContextService({ read, locate: async () => null, content: async () => "", clear() {} });
  service.pricing.refresh = async () => {};
  service.pricing.priceRequests = (_provider, requests) => requests.map((request) => ({ ...request,
    costUsd: service.pricing.revision ? request.usage.input / 100 : request.id === "r1" ? 1 : null }));
  const scope = scopeSchema.parse({ range: "all", sort: "tokens" });
  try {
    expect(await service.overview(scope, 0, paseo)).toMatchObject({ tokens: 330, calls: 2, costUsd: 1, costComplete: false,
      costSessions: 1, usageSessions: 2, pairedInput: 300, pairedRead: 110, days: [{ costUsd: null }] });
    const first = service["corpus"]!.shards;
    expect(service["summaries"].peek("one")).toBe(first.get("one"));
    expect(first.get("one")?.days).toHaveLength(1);
    await service.backfill(paseo);
    expect(service["corpus"]!.shards.get("one")).toBe(first.get("one"));
    expect(service["corpus"]!.shards.get("two")).toBe(first.get("two"));
    expect(read).toHaveBeenCalledTimes(2);

    response(one, "r3", 300, 200, 30);
    agents[0] = { ...agents[0], updatedAt: "2026-11-23T15:00:00Z" };
    await service.backfill(paseo);
    const changed = service["corpus"]!.shards;
    expect(changed.get("one")).not.toBe(first.get("one"));
    expect(changed.get("two")).toBe(first.get("two"));
    expect(read).toHaveBeenCalledTimes(3);
    expect(await service.overview(scope, 0, paseo)).toMatchObject({ tokens: 660, calls: 3, costUsd: 1, costComplete: false, pairedRead: 310 });

    service.pricing.revision++;
    expect(await service.overview(scope, 0, paseo)).toMatchObject({ tokens: 660, calls: 3, costUsd: 6, costComplete: true,
      costSessions: 2, usageSessions: 2, days: [{ costUsd: 6 }], projects: [{ key: "/demo", sessions: 2, tokens: 660 }] });
    const repriced = service["corpus"]!.shards;
    expect(repriced.get("one")).not.toBe(changed.get("one"));
    expect(repriced.get("two")).not.toBe(changed.get("two"));
    expect(service["summaries"].peek("two")).toBe(repriced.get("two"));
    expect(read).toHaveBeenCalledTimes(5);
  } finally { service.clear(); }
});

test("insights returns verified sessions before a slow session, then fills in the complete corpus", async () => {
  vi.useFakeTimers();
  const { service, paseo, list, finish } = fixture();
  const scope = scopeSchema.parse({ range: "all" });
  try {
    const first = service.overviewForScreen(scope, 0, paseo, "");
    const exact = service.overview(scope, 0, paseo);
    await vi.advanceTimersByTimeAsync(400);
    const preview = await first;
    expect(list).toHaveBeenCalledTimes(1);
    expect(preview.coverage).toMatchObject({ running: true, complete: false, total: 5, covered: 4, remaining: 1 });
    expect(preview.data?.total).toBe(4);
    expect(await service.overviewForScreen(scope, 0, paseo, preview.revision)).toMatchObject({ data: null, refreshing: true });
    finish();
    const full = await exact;
    const settled = await service.overviewForScreen(scope, 0, paseo, preview.revision);
    expect(settled.coverage).toMatchObject({ running: false, complete: true, total: 5, covered: 5, remaining: 0 });
    expect(settled.data).toEqual(full);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await service.overviewForScreen(scope, 0, paseo, "")).toMatchObject({ data: { total: 5 }, refreshing: true });
    await service.overview(scope, 0, paseo);
    expect(list).toHaveBeenCalledTimes(2);
  } finally { finish(); service.clear(); vi.useRealTimers(); }
});

test("retains the completed snapshot and reports a failed refresh until recovery", async () => {
  vi.useFakeTimers();
  const { service, paseo, list, finish } = fixture();
  const scope = scopeSchema.parse({ range: "all" });
  finish();
  try {
    const before = await service.overviewForScreen(scope, 0, paseo, "");
    await vi.advanceTimersByTimeAsync(11_000);
    list.mockRejectedValueOnce(new Error("Directory unavailable"));
    await service.overviewForScreen(scope, 0, paseo, before.revision);
    await vi.advanceTimersByTimeAsync(0);
    const stale = await service.overviewForScreen(scope, 0, paseo, before.revision);
    expect(stale).toMatchObject({ refreshing: false, refreshFailed: true, data: { total: 5 } });
    expect(stale.revision).not.toBe(before.revision);
    await service.backfill(paseo);
    expect(await service.overviewForScreen(scope, 0, paseo, stale.revision)).toMatchObject({
      refreshing: false, refreshFailed: false, data: { total: 5 },
    });
  } finally { service.clear(); vi.useRealTimers(); }
});

test("reports unreadable and failed sessions separately while retaining usable insights", async () => {
  const { service, paseo, refetch, finish } = fixture();
  const read = refetch.getMockImplementation()!;
  refetch.mockImplementation(async (id) => {
    if (id === "a0") throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    if (id === "a1") throw new Error("Invalid session record");
    return read(id);
  });
  try {
    const snapshot = await service.overviewForScreen(scopeSchema.parse({ range: "all" }), 0, paseo, "");
    expect(snapshot.coverage).toMatchObject({
      remaining: 0, covered: 3, unreadable: 1, failed: 1,
      unreadableSessions: [{ id: "a0", reason: "Permission denied" }],
      failedSessions: [{ id: "a1", reason: "Invalid session record" }],
    });
    refetch.mockImplementation(read);
    finish();
    expect(await service.backfill(paseo)).toMatchObject({ complete: true, covered: 5 });
  } finally { finish(); service.clear(); }
});

test("keeps a usable snapshot when the directory is available but every session read fails", async () => {
  vi.useFakeTimers();
  const { service, paseo, refetch, finish } = fixture();
  const scope = scopeSchema.parse({ range: "all" });
  const read = refetch.getMockImplementation()!;
  finish();
  try {
    const before = await service.overviewForScreen(scope, 0, paseo, "");
    await vi.advanceTimersByTimeAsync(16_000);
    refetch.mockRejectedValue(new Error("Session unavailable"));
    expect(await service.backfill(paseo)).toMatchObject({ failed: 5, covered: 0 });
    const stale = await service.overviewForScreen(scope, 0, paseo, before.revision);
    expect(stale).toMatchObject({
      refreshing: false, refreshFailed: true, data: { total: 5 },
      coverage: { refreshIssues: expect.arrayContaining([{ id: "a0", reason: "Session unavailable" }]) },
    });
    refetch.mockImplementation(read);
    expect(await service.backfill(paseo)).toMatchObject({ failed: 0, covered: 5 });
    expect(await service.overviewForScreen(scope, 0, paseo, stale.revision)).toMatchObject({ refreshFailed: false, data: { total: 5 } });
  } finally { service.clear(); vi.useRealTimers(); }
});
