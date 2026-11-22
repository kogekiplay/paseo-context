import { act, create } from "react-test-renderer";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Listener = (event: any) => void;

const mocks = vi.hoisted(() => ({
  overviewMounts: 0,
  overviewRenders: 0,
  contextMounts: 0,
  renderedTree: null as ReactNode,
  modalCloseTrigger: null as (() => void) | null,
}));

vi.mock("react-dom/client", () => ({
  createRoot: () => ({
    render: (node: ReactNode) => { mocks.renderedTree = node; },
  }),
}));

vi.mock("../src/client/components/contextView", () => ({
  makeContextView: () => function MockContextView() {
    useEffect(() => { mocks.contextMounts++; }, []);
    return "ContextView";
  },
}));
vi.mock("../src/client/components/fleetView", () => ({ makeFleetView: () => () => "FleetView" }));
vi.mock("../src/client/components/overviewPanel", () => ({
  makeOverviewPanel: () => function MockOverview() {
    mocks.overviewRenders++;
    useEffect(() => { mocks.overviewMounts++; }, []);
    return "Overview";
  },
}));
vi.mock("../src/client/components/settingsCard", () => ({ makePluginConfigCard: () => () => "SettingsCard" }));
vi.mock("../src/client/components/contextModal", () => ({
  makeContextModal: () => function MockModal() { return "ContextModal"; },
}));
vi.mock("../src/client/components/richText", () => ({
  makeRichText: () => ({ useRichView: () => ({ tools: null, body: null }) }),
}));
vi.mock("../web/statistics", () => ({ makeStatisticsView: () => () => "Statistics" }));
vi.mock("../src/client/historyPage", () => ({ watchHistoryFaces: () => {} }));
vi.mock("../.tmp/web/tailwind.css", () => ({}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const saved = {
  window: (globalThis as any).window,
  parent: (globalThis as any).parent,
  document: (globalThis as any).document,
  navigator: (globalThis as any).navigator,
  requestAnimationFrame: (globalThis as any).requestAnimationFrame,
};

let winListeners: Record<string, Listener[]> = {};
let docListeners: Record<string, Listener[]> = {};
let posted: unknown[] = [];
let renderer: ReturnType<typeof create> | null = null;
let bodyAttrs = new Map<string, string>();
let htmlDataset: Record<string, string> = {};
let bodyStyle: Record<string, string> = {};

function emitWin(type: string, event: any) {
  for (const fn of [...(winListeners[type] ?? [])]) fn(event);
}

beforeEach(() => {
  vi.resetModules();
  mocks.overviewMounts = 0;
  mocks.overviewRenders = 0;
  mocks.contextMounts = 0;
  mocks.renderedTree = null;
  winListeners = {};
  docListeners = {};
  posted = [];
  bodyAttrs = new Map();
  htmlDataset = {};
  bodyStyle = {};

  const win = {
    addEventListener: (type: string, fn: Listener) => { (winListeners[type] ??= []).push(fn); },
    removeEventListener: (type: string, fn: Listener) => { winListeners[type] = (winListeners[type] ?? []).filter((l) => l !== fn); },
    postMessage: (msg: unknown) => { posted.push(msg); },
  };
  (globalThis as any).window = win;
  (globalThis as any).parent = win;
  (globalThis as any).document = {
    hidden: false,
    documentElement: { dataset: htmlDataset },
    body: {
      style: bodyStyle,
      toggleAttribute: (name: string, force?: boolean) => { if (force) bodyAttrs.set(name, ""); else bodyAttrs.delete(name); },
      setAttribute: (name: string, value: string) => { bodyAttrs.set(name, value); },
      removeAttribute: (name: string) => { bodyAttrs.delete(name); },
      hasAttribute: (name: string) => bodyAttrs.has(name),
    },
    addEventListener: (type: string, fn: Listener) => { (docListeners[type] ??= []).push(fn); },
    getElementById: () => ({ textContent: "" }),
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: {} });
  (globalThis as any).requestAnimationFrame = (fn: () => void) => { fn(); return 1; };
  (globalThis as any).__PASEO_CONTEXT_NONCE__ = "main-nonce";
});

afterEach(async () => {
  emitWin("pagehide", { type: "pagehide" });
  if (renderer) await act(async () => renderer!.unmount());
  renderer = null;
  delete (globalThis as any).__PASEO_CONTEXT_NONCE__;
  delete (globalThis as any).__PASEO_CONTEXT_BOOTED__;
  delete (globalThis as any).__PASEO_CONTEXT_SEND__;
  delete (globalThis as any).__PASEO_CONTEXT_RECEIVE__;
  delete (globalThis as any).__PASEO_CONTEXT_ACK__;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete (globalThis as any)[key];
    else Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

describe("web/main entry lifecycle", () => {
  test("shows loading before first init, dedupes identical init, sets platform/dark, and scopes previewKey", async () => {
    await import("../web/main");
    expect((globalThis as any).__PASEO_CONTEXT_BOOTED__).toBe(true);
    expect(posted).toContainEqual({ type: "paseo-context:ready", nonce: "main-nonce" });

    await act(async () => { renderer = create(mocks.renderedTree as any); });
    // Before init: renders loading status instead of trend.empty.
    expect(JSON.stringify(renderer!.toJSON())).toContain("Loading");

    const initMsg = {
      type: "paseo-context:init",
      nonce: "main-nonce",
      mode: "insights",
      agentId: "",
      locale: "zh-CN",
      platform: "win32",
      dark: true,
      preview: true,
      preferences: { defaultOverviewRange: "7d", fleetTab: "show", defaultPlacement: "all" },
    };
    await act(async () => emitWin("message", { source: (globalThis as any).parent, data: initMsg }));
    expect(htmlDataset.platform).toBe("win32");
    expect(bodyAttrs.has("data-ds-dark-theme")).toBe(true);
    expect(bodyAttrs.has("data-pc-preview")).toBe(true);
    expect(mocks.overviewMounts).toBe(1);

    // Duplicate identical init does not re-render Overview.
    const rendersBeforeDedupe = mocks.overviewRenders;
    await act(async () => emitWin("message", { source: (globalThis as any).parent, data: { ...initMsg, preferences: { ...initMsg.preferences } } }));
    expect(mocks.overviewRenders).toBe(rendersBeforeDedupe);
    expect(mocks.overviewMounts).toBe(1);

    // Changing unrelated entry preference in preview does not remount Overview.
    await act(async () => emitWin("message", {
      source: (globalThis as any).parent,
      data: { ...initMsg, preferences: { ...initMsg.preferences, fleetTab: "hide" } },
    }));
    expect(mocks.overviewMounts).toBe(1);

    // Changing defaultOverviewRange DOES remount Overview in preview.
    await act(async () => emitWin("message", {
      source: (globalThis as any).parent,
      data: { ...initMsg, preferences: { ...initMsg.preferences, defaultOverviewRange: "30d" } },
    }));
    expect(mocks.overviewMounts).toBe(2);
  });

  test("modal mode opens modalStore and dispatches close action when dismissed", async () => {
    const { modalStoreOf } = await import("../src/client/modalStore");
    await import("../web/main");
    await act(async () => { renderer = create(mocks.renderedTree as any); });

    await act(async () => emitWin("message", {
      source: (globalThis as any).parent,
      data: {
        type: "paseo-context:init",
        nonce: "main-nonce",
        mode: "modal",
        agentId: "agent-modal",
        locale: "en",
        platform: "darwin",
        dark: false,
        preview: false,
        preferences: {},
      },
    }));
    expect(bodyStyle.background).toBe("transparent");
    expect(modalStoreOf("agent-modal").getSnapshot()).toBe(true);

    posted = [];
    await act(async () => { modalStoreOf("agent-modal").set(false); });
    expect(posted).toContainEqual(expect.objectContaining({ type: "paseo-context:action", nonce: "main-nonce", name: "close", payload: {}, aid: expect.any(Number) }));
  });

  test("compactDigest produces a tiny fixed-size hash for large family payloads", async () => {
    const { compactDigest } = await import("../web/main");
    const largeA = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ id: `a-${i}`, text: "payload".repeat(20) })) });
    const largeB = largeA.replace("a-199", "a-999");
    const digestA1 = compactDigest(largeA);
    const digestA2 = compactDigest(largeA);
    const digestB = compactDigest(largeB);
    expect(digestA1).toBe(digestA2);
    expect(digestA1).not.toBe(digestB);
    expect(digestA1.length).toBeLessThan(32);
  });
});
