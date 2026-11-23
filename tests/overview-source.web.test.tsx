import { act, create } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OverviewScope } from "../src/shared/types";

const postRouteMock = vi.hoisted(() => vi.fn());

vi.mock("../src/client/route", () => ({
  postRoute: (...args: unknown[]) => postRouteMock(...args),
  postRouteAction: vi.fn(),
}));
vi.mock("../src/client/costRefresh", () => ({
  notePricingPending: vi.fn(),
}));

import { useOverviewDays } from "../src/client/overviewSource";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const savedDocument = (globalThis as any).document;
let renderer: ReturnType<typeof create> | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  postRouteMock.mockReset();
  (globalThis as any).document = {
    visibilityState: "visible",
    body: { hasAttribute: () => true },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = null;
  vi.useRealTimers();
  if (savedDocument === undefined) delete (globalThis as any).document;
  else (globalThis as any).document = savedDocument;
});

function daysPayload(revision: string, tokens: number, refreshing: boolean) {
  return {
    revision,
    pricingReady: true,
    refreshing,
    refreshFailed: false,
    partial: refreshing,
    days: [{ key: "2026-11-23", tokens, sessions: 1, costUsd: 0.1 }],
    today: "2026-11-23",
  };
}

describe("overviewSource pending state during backfill refresh", () => {
  test("sets pending=true on initial load and scope change, but keeps pending=false during same-key background refresh", async () => {
    const pendingHistory: boolean[] = [];
    let latestState: ReturnType<typeof useOverviewDays> | null = null;

    function Probe({ scope }: { scope: OverviewScope }) {
      const state = useOverviewDays(scope, true);
      latestState = state;
      pendingHistory.push(state.pending);
      return null;
    }

    let resolveFirst!: (val: unknown) => void;
    let resolveSecond!: (val: unknown) => void;
    let resolveThird!: (val: unknown) => void;

    postRouteMock
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveThird = r; }));

    const scopeA: OverviewScope = { coverage: "all" };
    await act(async () => {
      renderer = create(createElement(Probe, { scope: scopeA }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // 1. Initial load with no held data -> pending MUST be true while in flight.
    expect(postRouteMock).toHaveBeenCalledTimes(1);
    expect(latestState!.pending).toBe(true);

    // Resolve first load with refreshing=true -> schedules background poll at 400ms.
    await act(async () => {
      resolveFirst(daysPayload("rev-1", 100, true));
      await Promise.resolve();
    });
    expect(latestState!.pending).toBe(false);
    expect(latestState!.data?.days[0].tokens).toBe(100);

    // 2. Background refresh fires at 400ms (not 250ms!) and MUST keep pending=false while in flight.
    pendingHistory.length = 0;
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(postRouteMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(postRouteMock).toHaveBeenCalledTimes(2);
    expect(latestState!.pending).toBe(false);
    expect(pendingHistory).not.toContain(true);

    await act(async () => {
      resolveSecond(daysPayload("rev-2", 250, false));
      await Promise.resolve();
    });
    expect(latestState!.pending).toBe(false);
    expect(latestState!.data?.days[0].tokens).toBe(250);
    expect(pendingHistory).not.toContain(true);

    // 3. Switching to a different scope (new key) -> no held data for new key, so pending MUST become true.
    const scopeB: OverviewScope = { coverage: "active" };
    await act(async () => {
      renderer!.update(createElement(Probe, { scope: scopeB }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(postRouteMock).toHaveBeenCalledTimes(3);
    expect(latestState!.pending).toBe(true);

    await act(async () => {
      resolveThird(daysPayload("rev-3", 50, false));
      await Promise.resolve();
    });
    expect(latestState!.pending).toBe(false);
    expect(latestState!.data?.days[0].tokens).toBe(50);
  });

  test("rapid A -> B -> A scope switch clears B's pending=true immediately when returning to cached A", async () => {
    let latestState: ReturnType<typeof useOverviewDays> | null = null;
    function Probe({ scope }: { scope: OverviewScope }) {
      latestState = useOverviewDays(scope, true);
      return null;
    }

    let resolveA1!: (val: unknown) => void;
    let resolveA2!: (val: unknown) => void;
    postRouteMock
      .mockImplementationOnce(() => new Promise((r) => { resolveA1 = r; }))
      .mockImplementationOnce(() => new Promise(() => {})) // B stays in flight
      .mockImplementationOnce(() => new Promise((r) => { resolveA2 = r; }));

    const scopeA: OverviewScope = { coverage: "all" };
    const scopeB: OverviewScope = { coverage: "active" };

    await act(async () => { renderer = create(createElement(Probe, { scope: scopeA })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => {
      resolveA1(daysPayload("rev-a1", 100, false));
      await Promise.resolve();
    });
    expect(latestState!.pending).toBe(false);

    // Switch A -> B: B has no held data -> pending becomes true.
    await act(async () => { renderer!.update(createElement(Probe, { scope: scopeB })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(latestState!.pending).toBe(true);

    // Rapidly switch B -> A before B resolves: A is still held -> pending MUST reset to false immediately.
    await act(async () => { renderer!.update(createElement(Probe, { scope: scopeA })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(postRouteMock).toHaveBeenCalledTimes(3);
    expect(latestState!.pending).toBe(false);
    expect(latestState!.data?.days[0].tokens).toBe(100);

    await act(async () => {
      resolveA2(daysPayload("rev-a2", 120, false));
      await Promise.resolve();
    });
    expect(latestState!.pending).toBe(false);
    expect(latestState!.data?.days[0].tokens).toBe(120);
  });
});
