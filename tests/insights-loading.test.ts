import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { expect, test, vi } from "vitest";
import { ContextService } from "../server/service";
import { SessionReader } from "../server/reader";
import { scopeSchema } from "../shared/contracts";

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
