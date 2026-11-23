import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { interpolateBounded, parseFoldProgress, watchBackfillMotion } from "../web/backfill-motion";

type AsyncObserverEntry = {
  cb: MutationCallback;
  options: MutationObserverInit;
  pending: boolean;
  disconnected: boolean;
};

const observers = new Set<AsyncObserverEntry>();

function notifyObservers(kind: "characterData" | "childList") {
  for (const entry of observers) {
    if (entry.disconnected) continue;
    if (kind === "characterData" && !entry.options.characterData) continue;
    if (kind === "childList" && !entry.options.childList) continue;
    if (entry.pending) continue;
    entry.pending = true;
    queueMicrotask(() => {
      entry.pending = false;
      if (!entry.disconnected) entry.cb([], {} as MutationObserver);
    });
  }
}

class FakeElement {
  private _text: string;
  private _connected = true;
  private attrs = new Map<string, string>();
  private classes = new Set<string>();
  classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
  };

  constructor(text: string) {
    this._text = text;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  get textContent(): string {
    return this._text;
  }

  set textContent(value: string) {
    this._text = value;
    // Mirror real browser behavior: setting textContent schedules async microtask MutationObserver callback.
    notifyObservers("characterData");
  }

  disconnectFromDom(): void {
    this._connected = false;
    notifyObservers("childList");
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
}

const saved = {
  window: (globalThis as any).window,
  MutationObserver: (globalThis as any).MutationObserver,
  requestAnimationFrame: (globalThis as any).requestAnimationFrame,
  cancelAnimationFrame: (globalThis as any).cancelAnimationFrame,
  performance: (globalThis as any).performance,
};

let reducedMotion = false;
let disconnectSpy = vi.fn();
let observeOptionsSpy = vi.fn();
let rafQueue = new Map<number, (now: number) => void>();
let cancelledRafs: number[] = [];
let nextRafId = 1;
let nowMs = 1000;

beforeEach(() => {
  observers.clear();
  reducedMotion = false;
  disconnectSpy = vi.fn();
  observeOptionsSpy = vi.fn();
  rafQueue = new Map();
  cancelledRafs = [];
  nextRafId = 1;
  nowMs = 1000;

  (globalThis as any).window = {
    matchMedia: (query: string) => ({ matches: query.includes("reduce") ? reducedMotion : !reducedMotion }),
  };
  (globalThis as any).MutationObserver = class AsyncMicrotaskMutationObserver {
    private entry: AsyncObserverEntry;
    constructor(cb: MutationCallback) {
      this.entry = { cb, options: {}, pending: false, disconnected: false };
    }
    observe(_target: Node, options: MutationObserverInit = {}) {
      observeOptionsSpy(options);
      this.entry.options = options;
      observers.add(this.entry);
    }
    disconnect() {
      this.entry.disconnected = true;
      observers.delete(this.entry);
      disconnectSpy();
    }
  };
  (globalThis as any).requestAnimationFrame = (cb: (now: number) => void) => {
    const id = nextRafId++;
    rafQueue.set(id, cb);
    return id;
  };
  (globalThis as any).cancelAnimationFrame = (id: number) => {
    cancelledRafs.push(id);
    rafQueue.delete(id);
  };
  (globalThis as any).performance = { now: () => nowMs };
});

afterEach(() => {
  observers.clear();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (globalThis as any)[key];
    else Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function flushRaf(atMs: number) {
  nowMs = atMs;
  const entries = [...rafQueue.entries()];
  rafQueue.clear();
  for (const [, cb] of entries) cb(atMs);
}

describe("web/backfill-motion", () => {
  test("parses progress labels across locales and rejects out-of-bounds values", () => {
    expect(parseFoldProgress("投影补算中（31/90）…")).toEqual({ prefix: "投影补算中（", covered: 31, total: 90, suffix: "）…" });
    expect(parseFoldProgress("Folding projections (12/45)…")).toEqual({ prefix: "Folding projections (", covered: 12, total: 45, suffix: ")…" });
    expect(parseFoldProgress("投影を補算中（5/20）…")).toEqual({ prefix: "投影を補算中（", covered: 5, total: 20, suffix: "）…" });
    expect(parseFoldProgress("Расчёт проекций (0/10)…")).toEqual({ prefix: "Расчёт проекций (", covered: 0, total: 10, suffix: ")…" });
    expect(parseFoldProgress("投影补算中（91/90）…")).toBeNull();
    expect(parseFoldProgress("投影补算中（0/0）…")).toBeNull();
    expect(parseFoldProgress("无数字文本")).toBeNull();
  });

  test("interpolateBounded stays strictly within [from, to]", () => {
    expect(interpolateBounded(10, 30, -0.5)).toBe(10);
    expect(interpolateBounded(10, 30, 0)).toBe(10);
    const mid = interpolateBounded(10, 30, 0.5);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThanOrEqual(30);
    expect(interpolateBounded(10, 30, 1)).toBe(30);
    expect(interpolateBounded(10, 30, 2)).toBe(30);
  });

  test("uses async MutationObserver without mutating textContent, animates via data attributes, and cancels rAF immediately on DOM removal", async () => {
    const pill = new FakeElement("投影补算中（10/90）…");
    const kpiInt = new FakeElement("10");
    const kpiFormatted = new FakeElement("1.2M");
    const root = {
      querySelectorAll: (sel: string) => {
        if (sel.includes(".lc-ov-folding")) return pill.isConnected ? [pill] : [];
        if (sel.includes(".lc-ov-kpi")) return [kpiInt, kpiFormatted].filter((el) => el.isConnected);
        return [];
      },
    } as unknown as Node;

    const dispose = watchBackfillMotion(root);
    expect(observeOptionsSpy).toHaveBeenCalledWith({ childList: true, subtree: true, characterData: true });
    expect(rafQueue.size).toBe(0);

    // Server updates text nodes -> triggers real async microtask MutationObserver.
    pill.textContent = "投影补算中（30/90）…";
    kpiInt.textContent = "30";
    kpiFormatted.textContent = "2.4M";
    await flushMicrotasks();

    // DOM textContent MUST remain the authoritative server text at every moment.
    expect(pill.textContent).toBe("投影补算中（30/90）…");
    expect(kpiInt.textContent).toBe("30");
    expect(pill.getAttribute("data-pc-animating")).toBe("1");
    expect(pill.getAttribute("data-pc-display")).toBe("投影补算中（10/90）…");
    expect(kpiInt.getAttribute("data-pc-animating")).toBe("1");
    expect(kpiInt.getAttribute("data-pc-display")).toBe("10");
    expect(rafQueue.size).toBe(3);

    // Advance one frame and flush microtasks to ensure no observer feedback loop cancels the animation.
    flushRaf(1080);
    await flushMicrotasks();
    expect(pill.textContent).toBe("投影补算中（30/90）…");
    const midParsed = parseFoldProgress(pill.getAttribute("data-pc-display")!)!;
    expect(midParsed.covered).toBeGreaterThan(10);
    expect(midParsed.covered).toBeLessThanOrEqual(30);
    const midKpi = Number(kpiInt.getAttribute("data-pc-display"));
    expect(midKpi).toBeGreaterThan(10);
    expect(midKpi).toBeLessThanOrEqual(30);
    expect(kpiFormatted.classList.contains("pc-kpi-bump")).toBe(true);
    expect(rafQueue.size).toBe(2);

    // Final frame clears data-pc-animating and data-pc-display cleanly.
    flushRaf(1250);
    await flushMicrotasks();
    expect(pill.textContent).toBe("投影补算中（30/90）…");
    expect(pill.getAttribute("data-pc-animating")).toBeNull();
    expect(pill.getAttribute("data-pc-display")).toBeNull();
    expect(kpiInt.getAttribute("data-pc-animating")).toBeNull();
    expect(kpiInt.getAttribute("data-pc-display")).toBeNull();
    expect(rafQueue.size).toBe(0);

    // Removing an animating element from the DOM immediately cancels its rAF handle on observer delivery.
    pill.textContent = "投影补算中（60/90）…";
    await flushMicrotasks();
    expect(rafQueue.size).toBe(1);
    const pendingHandle = [...rafQueue.keys()][0];
    cancelledRafs = [];
    pill.disconnectFromDom();
    await flushMicrotasks();
    expect(cancelledRafs).toContain(pendingHandle);
    expect(rafQueue.size).toBe(0);
    expect(pill.getAttribute("data-pc-animating")).toBeNull();
    expect(pill.getAttribute("data-pc-display")).toBeNull();

    dispose();
    expect(disconnectSpy).toHaveBeenCalledOnce();
  });

  test("respects prefers-reduced-motion: reduce and ships overlay + reduced-motion CSS guards in web/shell.css", async () => {
    reducedMotion = true;
    const pill = new FakeElement("投影补算中（10/90）…");
    const root = {
      querySelectorAll: (sel: string) => (sel.includes(".lc-ov-folding") ? [pill] : []),
    } as unknown as Node;
    const dispose = watchBackfillMotion(root);
    pill.textContent = "投影补算中（40/90）…";
    await flushMicrotasks();
    expect(rafQueue.size).toBe(0);
    expect(pill.textContent).toBe("投影补算中（40/90）…");
    expect(pill.getAttribute("data-pc-animating")).toBeNull();
    expect(pill.getAttribute("data-pc-display")).toBeNull();
    dispose();

    const css = readFileSync(resolve(process.cwd(), "web/shell.css"), "utf8");
    expect(css).toContain(".lc-ov-folding:not(.lc-ov-folding-action)");
    expect(css).toContain('[data-pc-animating="1"]::after');
    expect(css).toContain("attr(data-pc-display)");
    expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(css).toContain("pc-spin");
    expect(css).toContain("pc-shimmer");
  });
});
