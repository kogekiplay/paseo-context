import { act, create } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  platform: { OS: "web" },
  openURL: vi.fn(),
  copyText: vi.fn(async () => {}),
  rpc: vi.fn(async (input: { route: string; payload?: any }) => input.route === "ui.document"
    ? '<script>globalThis.__PASEO_CONTEXT_NONCE__="%%PASEO_CONTEXT_NONCE%%";</script>'
    : { ok: true }),
  previewRpc: vi.fn(async () => ({ preview: true })),
  settings: {
    status: "ready" as "loading" | "ready" | "error" | "invalid",
    revision: "rev-1",
    values: { defaultPlacement: "all", fleetTab: true } as Record<string, unknown>,
    save: vi.fn(async (_next?: Record<string, unknown>, _rev?: string) => true),
    reload: vi.fn(async () => {}),
    error: undefined as string | undefined,
  },
}));

vi.mock("react-native", () => ({
  Platform: mocks.platform,
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  Linking: { openURL: mocks.openURL },
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (def: { name?: string }) => def?.name === "context.settings-preview" ? mocks.previewRpc : mocks.rpc,
  useSettings: () => mocks.settings,
  useTranslation: () => ({ locale: "zh-CN", t: (k: string) => k }),
  defineTranslations: (value: unknown) => value,
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  copyText: mocks.copyText,
}));

import { WebFrame } from "../client/web";
import { isDarkColor, platformNameOf } from "../client/bridge-shared";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReturnType<typeof create> | null = null;
let queryClient: QueryClient;
let messageListeners: Array<(event: any) => void> = [];
let createdBlobs: Array<{ url: string; html: string }> = [];
let revokedUrls: string[] = [];
let postMessageMock = vi.fn();

const originalWindow = (globalThis as any).window;
const originalBlob = (globalThis as any).Blob;
const originalCreateObjectURL = (globalThis.URL as any)?.createObjectURL;
const originalRevokeObjectURL = (globalThis.URL as any)?.revokeObjectURL;

beforeEach(() => {
  messageListeners = [];
  createdBlobs = [];
  revokedUrls = [];
  postMessageMock = vi.fn();
  (globalThis as any).window = {
    addEventListener: (type: string, fn: (event: any) => void) => { if (type === "message") messageListeners.push(fn); },
    removeEventListener: (type: string, fn: (event: any) => void) => { if (type === "message") messageListeners = messageListeners.filter((l) => l !== fn); },
  };
  (globalThis as any).Blob = class MockBlob {
    parts: string[];
    constructor(parts: string[]) { this.parts = parts; }
  };
  (globalThis.URL as any).createObjectURL = (blob: any) => {
    const url = `blob:mock-${createdBlobs.length + 1}`;
    createdBlobs.push({ url, html: String(blob.parts[0]) });
    return url;
  };
  (globalThis.URL as any).revokeObjectURL = (url: string) => { revokedUrls.push(url); };
  mocks.platform.OS = "web";
  mocks.settings.status = "ready";
  mocks.settings.revision = "rev-1";
  mocks.settings.values = { defaultPlacement: "all", fleetTab: true };
  mocks.settings.error = undefined;
  mocks.settings.save.mockResolvedValue(true);
});

afterEach(async () => {
  vi.useRealTimers();
  if (renderer) await act(async () => renderer?.unmount());
  queryClient?.clear();
  renderer = null;
  vi.clearAllMocks();
  if (originalWindow === undefined) delete (globalThis as any).window; else (globalThis as any).window = originalWindow;
  (globalThis as any).Blob = originalBlob;
  (globalThis.URL as any).createObjectURL = originalCreateObjectURL;
  (globalThis.URL as any).revokeObjectURL = originalRevokeObjectURL;
});

const baseProps = {
  mode: "context" as const,
  agentId: "agent-1",
  theme: { colors: { surface0: "rgb(18, 20, 24)", foreground: "#ffffff", foregroundMuted: "#aaaaaa", accent: "#3b82f6" } },
  host: { id: "host", label: "Host" },
  layout: { compact: false, platform: "web" as const },
  openSettings: vi.fn(),
  openContext: vi.fn(),
};

async function mount(overrides: Record<string, unknown> = {}) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const frameWindow = { postMessage: postMessageMock };
  await act(async () => {
    renderer = create(
      createElement(QueryClientProvider, { client: queryClient },
        createElement(WebFrame, { ...baseProps, ...overrides } as any)),
      { createNodeMock: (el) => el.type === "iframe" ? { contentWindow: frameWindow } : null },
    );
  });
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10);
    else await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return { root: renderer!.root, frameWindow };
}

function dispatchMessage(source: unknown, data: unknown) {
  for (const fn of [...messageListeners]) fn({ source, data });
}

describe("WebFrame and shared bridge helpers", () => {
  test("parses hex and rgb/rgba colors for dark mode and maps host platforms", () => {
    expect(isDarkColor("#000")).toBe(true);
    expect(isDarkColor("#fff")).toBe(false);
    expect(isDarkColor("#101214ff")).toBe(true);
    expect(isDarkColor("rgb(20, 24, 28)")).toBe(true);
    expect(isDarkColor("rgba(245, 245, 245, 0.9)")).toBe(false);
    expect(isDarkColor("invalid")).toBe(false);
    expect(platformNameOf("web", "MacIntel")).toBe("darwin");
    expect(platformNameOf("web", "Win32")).toBe("win32");
    expect(platformNameOf("web", "Linux x86_64")).toBe("linux");
    expect(platformNameOf("android")).toBe("android");
  });

  test("loads ui.document via bridgeRpc, validates nonce/source, revokes Blob URL on unmount, and ignores non-fatal errors", async () => {
    const { root, frameWindow } = await mount();
    expect(mocks.rpc).toHaveBeenCalledWith({ route: "ui.document", payload: {} });
    expect(createdBlobs).toHaveLength(1);
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(createdBlobs[0].html)![1];

    // Wrong source / wrong nonce ignored.
    await act(async () => {
      dispatchMessage({}, { type: "paseo-context:ready", nonce });
      dispatchMessage(frameWindow, { type: "paseo-context:ready", nonce: "wrong" });
    });
    expect(postMessageMock).not.toHaveBeenCalled();

    // Valid ready sends init payload with parsed dark mode and platform.
    await act(async () => {
      dispatchMessage(frameWindow, { type: "paseo-context:ready", nonce });
    });
    expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      type: "paseo-context:init", nonce, dark: true, mode: "context", agentId: "agent-1",
    }), "*");

    // Non-fatal runtime error reports ui.error and keeps iframe mounted.
    await act(async () => {
      dispatchMessage(frameWindow, { type: "paseo-context:error", nonce, message: "Minor async issue" });
    });
    expect(mocks.rpc).toHaveBeenCalledWith({ route: "ui.error", payload: { message: "Minor async issue" } });
    expect(root.findAllByType("iframe" as any)).toHaveLength(1);

    // Unmount revokes Blob URL.
    await act(async () => renderer!.unmount());
    renderer = null;
    expect(revokedUrls).toEqual(["blob:mock-1"]);
  });

  test("serializes concurrent settings.set saves, rejects prototype keys, and supports clipboard.write in preview", async () => {
    const { frameWindow } = await mount();
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(createdBlobs[0].html)![1];

    // Reject prototype key (Object.hasOwn check).
    postMessageMock.mockClear();
    await act(async () => {
      dispatchMessage(frameWindow, { type: "paseo-context:rpc", nonce, id: 1, route: "settings.set", payload: { field: "toString", value: "x" } });
    });
    expect(postMessageMock).toHaveBeenCalledWith(expect.objectContaining({ id: 1, error: "Unknown preference" }), "*");

    // Concurrent settings.set calls serialize and read updated revision.
    let resolveFirst!: (ok: boolean) => void;
    const callOrder: string[] = [];
    mocks.settings.save.mockImplementationOnce((next: any, rev: any) => {
      callOrder.push(`first:${rev}`);
      return new Promise<boolean>((resolve) => {
        resolveFirst = (ok) => {
          mocks.settings.values = next;
          mocks.settings.revision = "rev-2";
          resolve(ok);
        };
      });
    }).mockImplementationOnce(async (next: any, rev: any) => {
      callOrder.push(`second:${rev}`);
      mocks.settings.values = next;
      mocks.settings.revision = "rev-3";
      return true;
    });

    await act(async () => {
      dispatchMessage(frameWindow, { type: "paseo-context:rpc", nonce, id: 2, route: "settings.set", payload: { field: "fleetTab", value: "hide" } });
      dispatchMessage(frameWindow, { type: "paseo-context:rpc", nonce, id: 3, route: "settings.set", payload: { field: "defaultPlacement", value: "tab" } });
      await Promise.resolve();
    });
    expect(callOrder).toEqual(["first:rev-1"]);
    await act(async () => { resolveFirst(true); await Promise.resolve(); await Promise.resolve(); });
    expect(callOrder).toEqual(["first:rev-1", "second:rev-2"]);

    // Preview mode still executes clipboard.write locally.
    await act(async () => renderer!.unmount());
    renderer = null;
    const preview = await mount({
      preview: { values: { defaultPlacement: "all", fleetTab: true }, onSelectAgent: vi.fn(), onSelectPage: vi.fn() },
    });
    const previewNonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(createdBlobs.at(-1)!.html)![1];
    await act(async () => {
      dispatchMessage(preview.frameWindow, { type: "paseo-context:rpc", nonce: previewNonce, id: 4, route: "clipboard.write", payload: { text: "sample" } });
    });
    expect(mocks.copyText).toHaveBeenCalledWith("sample");
    expect(mocks.previewRpc).not.toHaveBeenCalled();
  });

  test("shows slow-load reload control after 15s and fatal teardown with close/reload", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { root, frameWindow } = await mount({ onClose });
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    const buttons = root.findAllByType("Pressable" as any);
    expect(buttons).toHaveLength(2);
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(createdBlobs[0].html)![1];
    await act(async () => {
      dispatchMessage(frameWindow, { type: "paseo-context:fatal", nonce, message: "Crash" });
    });
    expect(root.findAllByType("iframe" as any)).toHaveLength(0);
    await act(async () => root.findAllByType("Pressable" as any)[1].props.onPress());
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("lazily mounts iframe via IntersectionObserver, unmounts & revokes Blob after 60s hidden, and remounts when visible", async () => {
    vi.useFakeTimers();
    const callbacks: Array<(entries: Array<{ isIntersecting: boolean; boundingClientRect?: { width: number; height: number } }>) => void> = [];
    const disconnect = vi.fn();
    const originalIO = (globalThis as any).IntersectionObserver;
    (globalThis as any).IntersectionObserver = class MockIO {
      constructor(cb: any) { callbacks.push(cb); }
      observe() {}
      disconnect() { disconnect(); }
    };
    try {
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const frameWindow = { postMessage: postMessageMock };
      await act(async () => {
        renderer = create(
          createElement(QueryClientProvider, { client: queryClient },
            createElement(WebFrame, baseProps as any)),
          { createNodeMock: (el) => el.type === "iframe" ? { contentWindow: frameWindow } : el.type === "div" ? { tag: "div" } : null },
        );
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });

      // Initially hidden: no ui.document fetch, no Blob URL, no iframe.
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(createdBlobs).toHaveLength(0);
      expect(renderer!.root.findAllByType("iframe" as any)).toHaveLength(0);

      // Become visible -> mounts iframe & creates Blob URL.
      await act(async () => {
        callbacks[0]([{ isIntersecting: true, boundingClientRect: { width: 800, height: 600 } }]);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(createdBlobs).toHaveLength(1);
      expect(renderer!.root.findAllByType("iframe" as any)).toHaveLength(1);

      // Hidden for 59s -> still mounted.
      await act(async () => {
        callbacks[0]([{ isIntersecting: false, boundingClientRect: { width: 0, height: 0 } }]);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
      expect(renderer!.root.findAllByType("iframe" as any)).toHaveLength(1);
      expect(revokedUrls).toHaveLength(0);

      // Hidden reaches 60s -> unmounts iframe and revokes Blob URL.
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(renderer!.root.findAllByType("iframe" as any)).toHaveLength(0);
      expect(revokedUrls).toEqual(["blob:mock-1"]);

      // Visible again -> seamlessly remounts iframe with fresh Blob URL.
      await act(async () => {
        callbacks[0]([{ isIntersecting: true, boundingClientRect: { width: 800, height: 600 } }]);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(createdBlobs).toHaveLength(2);
      expect(renderer!.root.findAllByType("iframe" as any)).toHaveLength(1);

      // Preview & overlay bypass IntersectionObserver and mount immediately.
      await act(async () => renderer!.unmount());
      renderer = null;
      expect(disconnect).toHaveBeenCalled();
      const overlayRes = await mount({ overlay: true });
      expect(overlayRes.root.findAllByType("iframe" as any)).toHaveLength(1);
    } finally {
      if (originalIO === undefined) delete (globalThis as any).IntersectionObserver;
      else (globalThis as any).IntersectionObserver = originalIO;
    }
  });
});
