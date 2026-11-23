import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  interpolateBounded,
  interpolateMetricBounded,
  parseFoldProgress,
  parseFormattedMetric,
  watchBackfillMotion,
} from "../web/backfill-motion";

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
  test("parses progress labels and formatted metrics while rejecting durations and invalid values", () => {
    expect(parseFoldProgress("投影补算中（31/90）…")).toEqual({ prefix: "投影补算中（", covered: 31, total: 90, suffix: "）…" });
    expect(parseFoldProgress("Folding projections (12/45)…")).toEqual({ prefix: "Folding projections (", covered: 12, total: 45, suffix: ")…" });
    expect(parseFoldProgress("投影补算中（91/90）…")).toBeNull();
    expect(parseFoldProgress("投影补算中（0/0）…")).toBeNull();

    expect(parseFormattedMetric("89.0M")).toEqual({ prefix: "", value: 89, decimals: 1, suffix: "M" });
    expect(parseFormattedMetric("¥224.29")).toEqual({ prefix: "¥", value: 224.29, decimals: 2, suffix: "" });
    expect(parseFormattedMetric("88.9%")).toEqual({ prefix: "", value: 88.9, decimals: 1, suffix: "%" });
    expect(parseFormattedMetric("4.9k")).toEqual({ prefix: "", value: 4.9, decimals: 1, suffix: "k" });
    expect(parseFormattedMetric("40")).toEqual({ prefix: "", value: 40, decimals: 0, suffix: "" });
    expect(parseFormattedMetric("5h23m")).toBeNull();
    expect(parseFormattedMetric("—")).toBeNull();
  });

  test("bounded interpolation clamps strictly within [min, max] for both upward and downward updates", () => {
    expect(interpolateBounded(10, 30, 0)).toBe(10);
    expect(interpolateBounded(10, 30, 1)).toBe(30);
    const midInt = interpolateBounded(10, 30, 0.5);
    expect(midInt).toBeGreaterThan(10);
    expect(midInt).toBeLessThanOrEqual(30);

    const midUp = interpolateMetricBounded(89.0, 92.4, 0.4, 1);
    expect(midUp).toBeGreaterThan(89.0);
    expect(midUp).toBeLessThanOrEqual(92.4);

    const midDown = interpolateMetricBounded(89.2, 88.7, 0.4, 1);
    expect(midDown).toBeLessThan(89.2);
    expect(midDown).toBeGreaterThanOrEqual(88.7);
  });

  test("smoothly rolls progress, integer KPIs, and formatted KPIs without mutating textContent or adding flicker classes", async () => {
    const pill = new FakeElement("投影补算中（57/93）…");
    const kpiSessions = new FakeElement("40");
    const kpiTokens = new FakeElement("89.0M");
    const kpiCost = new FakeElement("¥224.29");
    const kpiCache = new FakeElement("88.9%");
    const kpiUnitJump = new FakeElement("999.0k");
    const kpiPrecisionJump = new FakeElement("$0.099");
    const kpiDuration = new FakeElement("5h23m");
    const kpiPlaceholder = new FakeElement("—");
    const kpis = [kpiSessions, kpiTokens, kpiCost, kpiCache, kpiUnitJump, kpiPrecisionJump, kpiDuration, kpiPlaceholder];

    const root = {
      querySelectorAll: (sel: string) => {
        if (sel.includes(".lc-ov-folding")) return pill.isConnected ? [pill] : [];
        if (sel.includes(".lc-ov-kpi")) return kpis.filter((el) => el.isConnected);
        return [];
      },
    } as unknown as Node;

    const dispose = watchBackfillMotion(root);
    expect(observeOptionsSpy).toHaveBeenCalledWith({ childList: true, subtree: true, characterData: true });
    expect(rafQueue.size).toBe(0);

    // Server reports next backfill tick.
    pill.textContent = "投影补算中（62/93）…";
    kpiSessions.textContent = "45";
    kpiTokens.textContent = "92.4M";
    kpiCost.textContent = "¥231.50";
    kpiCache.textContent = "89.2%";
    kpiUnitJump.textContent = "1.0M";
    kpiPrecisionJump.textContent = "$0.11";
    kpiDuration.textContent = "5h40m";
    kpiPlaceholder.textContent = "89.0M";
    await flushMicrotasks();

    // DOM textContent always remains the exact authoritative server string.
    expect(pill.textContent).toBe("投影补算中（62/93）…");
    expect(kpiTokens.textContent).toBe("92.4M");
    expect(kpiCost.textContent).toBe("¥231.50");
    expect(kpiCache.textContent).toBe("89.2%");

    // Matching-unit KPIs + pill animate via data attributes; unit change / duration / placeholder stay silent.
    expect(pill.getAttribute("data-pc-display")).toBe("投影补算中（57/93）…");
    expect(kpiSessions.getAttribute("data-pc-display")).toBe("40");
    expect(kpiTokens.getAttribute("data-pc-display")).toBe("89.0M");
    expect(kpiCost.getAttribute("data-pc-display")).toBe("¥224.29");
    expect(kpiCache.getAttribute("data-pc-display")).toBe("88.9%");
    expect(kpiUnitJump.getAttribute("data-pc-animating")).toBeNull();
    expect(kpiPrecisionJump.getAttribute("data-pc-animating")).toBeNull();
    expect(kpiDuration.getAttribute("data-pc-animating")).toBeNull();
    expect(kpiPlaceholder.getAttribute("data-pc-animating")).toBeNull();
    for (const el of kpis) expect(el.classList.contains("pc-kpi-bump")).toBe(false);
    expect(rafQueue.size).toBe(5);

    // Mid-way frame (~120ms / 320ms) rolls smoothly within bounds.
    flushRaf(1120);
    await flushMicrotasks();
    const midTokens = parseFormattedMetric(kpiTokens.getAttribute("data-pc-display")!)!;
    expect(midTokens.suffix).toBe("M");
    expect(midTokens.value).toBeGreaterThan(89.0);
    expect(midTokens.value).toBeLessThanOrEqual(92.4);

    const midCost = parseFormattedMetric(kpiCost.getAttribute("data-pc-display")!)!;
    expect(midCost.prefix).toBe("¥");
    expect(midCost.decimals).toBe(2);
    expect(midCost.value).toBeGreaterThan(224.29);
    expect(midCost.value).toBeLessThanOrEqual(231.50);

    const midCache = parseFormattedMetric(kpiCache.getAttribute("data-pc-display")!)!;
    expect(midCache.suffix).toBe("%");
    expect(midCache.value).toBeGreaterThan(88.9);
    expect(midCache.value).toBeLessThanOrEqual(89.2);

    // Final frame (>= 320ms) cleans up all animation attributes.
    flushRaf(1360);
    await flushMicrotasks();
    for (const el of [pill, ...kpis]) {
      expect(el.getAttribute("data-pc-animating")).toBeNull();
      expect(el.getAttribute("data-pc-display")).toBeNull();
    }
    expect(rafQueue.size).toBe(0);

    // Disconnecting an animating node immediately cancels its rAF handle.
    pill.textContent = "投影补算中（70/93）…";
    await flushMicrotasks();
    expect(rafQueue.size).toBe(1);
    const handle = [...rafQueue.keys()][0];
    cancelledRafs = [];
    pill.disconnectFromDom();
    await flushMicrotasks();
    expect(cancelledRafs).toContain(handle);
    expect(rafQueue.size).toBe(0);

    dispose();
    expect(disconnectSpy).toHaveBeenCalledOnce();
  });

  test("respects prefers-reduced-motion and web/shell.css removes shimmer and opacity flicker", async () => {
    reducedMotion = true;
    const pill = new FakeElement("投影补算中（10/90）…");
    const kpi = new FakeElement("89.0M");
    const root = {
      querySelectorAll: (sel: string) => (sel.includes(".lc-ov-folding") ? [pill] : [kpi]),
    } as unknown as Node;
    const dispose = watchBackfillMotion(root);
    pill.textContent = "投影补算中（40/90）…";
    kpi.textContent = "92.4M";
    await flushMicrotasks();
    expect(rafQueue.size).toBe(0);
    expect(pill.getAttribute("data-pc-animating")).toBeNull();
    expect(kpi.getAttribute("data-pc-animating")).toBeNull();
    dispose();

    const css = readFileSync(resolve(process.cwd(), "web/shell.css"), "utf8");
    expect(css).toContain("pc-spin");
    expect(css).toContain('[data-pc-animating="1"]::after');
    expect(css).toContain("attr(data-pc-display)");
    expect(css).toContain("overflow: visible;");
    expect(css).not.toContain("pc-shimmer");
    expect(css).not.toContain("pc-kpi-tick");
    expect(css).not.toContain("pc-kpi-bump");
  });
});
