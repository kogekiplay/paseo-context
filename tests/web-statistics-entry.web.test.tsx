import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";

type Listener = (event: any) => void;

const mocks = vi.hoisted(() => ({
  renderedTree: null as ReactNode,
  statsRenders: 0,
  lastProps: null as any,
}));

vi.mock("react-dom/client", () => ({
  createRoot: () => ({
    render: (node: ReactNode) => { mocks.renderedTree = node; },
  }),
}));
vi.mock("../web/statistics", () => ({
  makeStatisticsView: () => function MockStatistics(props: any) {
    mocks.statsRenders++;
    mocks.lastProps = props;
    return `Statistics:${props.sessionId}:${props.locale}`;
  },
}));
vi.mock("../web/vendor/theme/theme.css", () => ({}));
vi.mock("../web/shell.css", () => ({}));
vi.mock("../web/mobile.css", () => ({}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const saved = {
  window: (globalThis as any).window,
  parent: (globalThis as any).parent,
  document: (globalThis as any).document,
  navigator: (globalThis as any).navigator,
  Blob: (globalThis as any).Blob,
  atob: (globalThis as any).atob,
  createObjectURL: (globalThis.URL as any)?.createObjectURL,
  revokeObjectURL: (globalThis.URL as any)?.revokeObjectURL,
};

let winListeners: Record<string, Listener[]> = {};
let docListeners: Record<string, Listener[]> = {};
let posted: any[] = [];
let renderer: ReturnType<typeof create> | null = null;
let bodyAttrs = new Map<string, string>();
let htmlDataset: Record<string, string> = {};
let bodyStyle: Record<string, string> = {};
let createdUrls: string[] = [];
let revokedUrls: string[] = [];

function emitWin(type: string, event: any) {
  for (const fn of [...(winListeners[type] ?? [])]) fn(event);
}

beforeEach(() => {
  vi.resetModules();
  mocks.renderedTree = null;
  mocks.statsRenders = 0;
  mocks.lastProps = null;
  winListeners = {};
  docListeners = {};
  posted = [];
  bodyAttrs = new Map();
  htmlDataset = {};
  bodyStyle = {};
  createdUrls = [];
  revokedUrls = [];

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
  (globalThis as any).Blob = class MockBlob { constructor(public parts: unknown[], public opts?: unknown) {} };
  (globalThis as any).atob = (b64: string) => Buffer.from(b64, "base64").toString("binary");
  (globalThis.URL as any).createObjectURL = () => {
    const url = `blob:stats-${createdUrls.length + 1}`;
    createdUrls.push(url);
    return url;
  };
  (globalThis.URL as any).revokeObjectURL = (url: string) => { revokedUrls.push(url); };
  (globalThis as any).__PASEO_CONTEXT_NONCE__ = "stats-nonce";
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
    if (key === "createObjectURL") (globalThis.URL as any).createObjectURL = value;
    else if (key === "revokeObjectURL") (globalThis.URL as any).revokeObjectURL = value;
    else if (value === undefined) delete (globalThis as any)[key];
    else Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

describe("web/statistics-entry standalone lifecycle", () => {
  test("boots, handles init/dedupe, loads bootstrap statistics, and revokes thumb URLs on session switch & pagehide", async () => {
    await import("../web/statistics-entry");
    expect((globalThis as any).__PASEO_CONTEXT_BOOTED__).toBe(true);
    expect(posted).toContainEqual({ type: "paseo-context:ready", nonce: "stats-nonce" });

    await act(async () => { renderer = create(mocks.renderedTree as any); });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Loading");

    const initMsg = {
      type: "paseo-context:init",
      nonce: "stats-nonce",
      mode: "statistics",
      agentId: "agent-1",
      locale: "zh-CN",
      platform: "darwin",
      dark: true,
      preview: true,
    };
    await act(async () => emitWin("message", { source: (globalThis as any).parent, data: initMsg }));
    expect(htmlDataset.platform).toBe("darwin");
    expect(bodyAttrs.has("data-ds-dark-theme")).toBe(true);
    expect(bodyAttrs.has("data-pc-preview")).toBe(true);

    // Bootstrap RPC was sent with mode: "statistics".
    const bootstrapReq = posted.find((m) => m.type === "paseo-context:rpc" && m.route === "bootstrap");
    expect(bootstrapReq).toBeDefined();
    expect(bootstrapReq.payload).toMatchObject({ agentId: "agent-1", mode: "statistics" });

    // Deliver bootstrap response -> renders Statistics with snapshot and reports rendered status.
    await act(async () => emitWin("message", {
      source: (globalThis as any).parent,
      data: {
        type: "paseo-context:result",
        nonce: "stats-nonce",
        id: bootstrapReq.id,
        value: { familyRevision: "fam-1", selected: { revision: 1, statistics: { totals: { req: 3 } } } },
      },
    }));
    expect(mocks.statsRenders).toBe(1);
    expect(mocks.lastProps.sessionId).toBe("agent-1");
    expect(mocks.lastProps.snapshot).toEqual({ totals: { req: 3 } });
    expect(posted).toContainEqual({ type: "paseo-context:status", nonce: "stats-nonce", phase: "rendered" });

    // Duplicate init is ignored without re-rendering Statistics.
    await act(async () => emitWin("message", { source: (globalThis as any).parent, data: { ...initMsg } }));
    expect(mocks.statsRenders).toBe(1);

    // Thumbnail load uses variant="thumb" and creates an ObjectURL.
    const imgPromise = mocks.lastProps.loadImage({ attachmentId: "att-1" });
    const imgReq = posted.find((m) => m.type === "paseo-context:rpc" && m.route === "api/paseo-context/image");
    expect(imgReq.payload).toMatchObject({ sessionId: "agent-1", attachmentId: "att-1", variant: "thumb" });
    await act(async () => emitWin("message", {
      source: (globalThis as any).parent,
      data: { type: "paseo-context:result", nonce: "stats-nonce", id: imgReq.id, value: "data:image/png;base64,AA==" },
    }));
    expect(await imgPromise).toBe("blob:stats-1");

    // Switching agentId clears previous session thumbnail ObjectURLs.
    await act(async () => emitWin("message", {
      source: (globalThis as any).parent,
      data: { ...initMsg, agentId: "agent-2" },
    }));
    expect(revokedUrls).toEqual(["blob:stats-1"]);

    // Empty agentId shows empty status instead of loading.
    await act(async () => emitWin("message", {
      source: (globalThis as any).parent,
      data: { ...initMsg, agentId: "" },
    }));
    expect(JSON.stringify(renderer!.toJSON())).toContain("暂无记录");
  });
});
