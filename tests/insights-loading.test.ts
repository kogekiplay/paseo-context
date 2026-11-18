import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { expect, test, vi } from "vitest";
import { ContextService } from "../server/service";
import { SessionReader } from "../server/reader";
import { scopeSchema } from "../shared/contracts";

function fixture() {
  const agents = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, title: `A${i}`, labels: {}, cwd: "/demo",
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
    expect(stale).toMatchObject({ refreshing: false, refreshFailed: true, data: { total: 5 } });
    refetch.mockImplementation(read);
    expect(await service.backfill(paseo)).toMatchObject({ failed: 0, covered: 5 });
    expect(await service.overviewForScreen(scope, 0, paseo, stale.revision)).toMatchObject({ refreshFailed: false, data: { total: 5 } });
  } finally { service.clear(); vi.useRealTimers(); }
});
