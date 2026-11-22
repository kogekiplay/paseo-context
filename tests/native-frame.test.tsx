import { act, create } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  platform: { OS: "ios" }, dispatch: vi.fn(), navigation: vi.fn(), copyText: vi.fn(async () => {}),
  module: { shouldStartLoadWithLockIdentifier: vi.fn() },
  appStateListeners: new Set<(state: string) => void>(),
  appStateCurrent: "active",
  rpc: vi.fn(async (input: { route: string; payload?: any }): Promise<unknown> => input.route === "ui.document"
    ? '<script>globalThis.__PASEO_CONTEXT_NONCE__="%%PASEO_CONTEXT_NONCE%%";</script>'
    : { sessions: [], selected: null }),
  previewRpc: vi.fn(async () => ({ ok: true })),
  settings: {
    status: "ready", revision: "one",
    values: { defaultPlacement: "all", fleetTab: true },
    save: vi.fn(async () => true),
    reload: vi.fn(async () => {}),
    error: undefined as string | undefined,
  },
}));
vi.mock("react-native", () => ({
  Platform: mocks.platform, View: "View", Text: "Text", Pressable: "Pressable",
  AppState: {
    get currentState() { return mocks.appStateCurrent; },
    addEventListener: (_type: string, fn: (state: string) => void) => {
      mocks.appStateListeners.add(fn);
      return { remove: () => { mocks.appStateListeners.delete(fn); } };
    },
  },
  Linking: { openURL: mocks.navigation },
  UIManager: { dispatchViewManagerCommand: mocks.dispatch }, findNodeHandle: () => 7,
  TurboModuleRegistry: { get: () => mocks.module },
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (def: { name?: string }) => def?.name === "context.settings-preview" ? mocks.previewRpc : mocks.rpc,
  useSettings: () => mocks.settings,
  useTranslation: () => ({ locale: "zh-CN", t: () => "上下文" }),
  defineTranslations: (value: unknown) => value,
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  copyText: mocks.copyText,
  Modal: Object.assign(({ children }: any) => children, { Content: ({ children }: any) => children }),
}));
import { NativeFrame } from "../client/native";
import { nativeWebViewPool } from "../client/native-pool";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReturnType<typeof create> | null = null;
let queryClient: QueryClient;
afterEach(async () => {
  vi.useRealTimers();
  if (renderer) await act(async () => renderer?.unmount());
  nativeWebViewPool.reset();
  mocks.appStateListeners.clear();
  mocks.appStateCurrent = "active";
  queryClient?.clear();
  renderer = null; vi.clearAllMocks(); mocks.platform.OS = "ios";
  mocks.settings.status = "ready";
  mocks.settings.error = undefined;
  mocks.settings.revision = "one";
  mocks.rpc.mockImplementation(async (input: { route: string }) => input.route === "ui.document"
    ? '<script>globalThis.__PASEO_CONTEXT_NONCE__="%%PASEO_CONTEXT_NONCE%%";</script>'
    : { sessions: [], selected: null });
});
const baseProps = {
  mode: "insights" as const,
  theme: { colors: { surface0: "#111111", foreground: "#ffffff", foregroundMuted: "#aaaaaa", accent: "#3b82f6" } },
  host: { id: "host", label: "Host" },
  layout: { compact: true, platform: "ios" as const },
  openSettings: vi.fn(),
  openContext: vi.fn(),
};
async function mount(overrides: Record<string, unknown> = {}) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(createElement(QueryClientProvider, { client: queryClient },
      createElement(NativeFrame, { ...baseProps, ...overrides } as any)));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return renderer!.root;
}
describe("Native upstream UI container", () => {
  test("iPad receives the actual HTML and completes the nonce-checked initialization with platform", async () => {
    const root = await mount();
    const view = root.findByType("RNCWebView" as any);
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(view.props.source.html)![1];
    expect(view.props.javaScriptEnabled).toBe(true);
    expect(view.props.newSource).toBe(view.props.source);
    await act(async () => view.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "paseo-context:ready", nonce }) } }));
    expect(mocks.dispatch).toHaveBeenCalledWith(7, "injectJavaScript", [expect.stringContaining('"type":"paseo-context:init"')]);
    expect(mocks.dispatch).toHaveBeenCalledWith(7, "injectJavaScript", [expect.stringContaining('"platform":"ios"')]);
    expect(mocks.rpc).toHaveBeenCalledWith({ route: "ui.status", payload: { phase: "JavaScript ready", platform: "ios" } });
    mocks.dispatch.mockClear();
    await act(async () => view.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "paseo-context:ready", nonce: "other" }) } }));
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  test("blocks navigation away from the bundled local document", async () => {
    const root = await mount();
    const view = root.findByType("RNCWebView" as any);
    expect(view.props.source.baseUrl).toMatch(/^https:\/\/paseo-context\.invalid\/native[^/]+\/$/);
    view.props.onShouldStartLoadWithRequest({ nativeEvent: { url: "https://example.invalid", lockIdentifier: 4 } });
    view.props.onShouldStartLoadWithRequest({ nativeEvent: { url: "about:blank", lockIdentifier: 5 } });
    view.props.onShouldStartLoadWithRequest({ nativeEvent: { url: view.props.source.baseUrl, lockIdentifier: 6 } });
    expect(mocks.module.shouldStartLoadWithLockIdentifier.mock.calls).toEqual([[false, 4], [true, 5], [true, 6]]);
    await act(async () => view.props.onLoadingStart({ nativeEvent: { url: view.props.source.baseUrl } }));
    expect(mocks.dispatch).not.toHaveBeenCalledWith(7, "stopLoading", []);
    await act(async () => view.props.onLoadingStart({ nativeEvent: { url: "https://example.invalid" } }));
    expect(mocks.dispatch).toHaveBeenCalledWith(7, "stopLoading", []);
  });

  test("shares static markup across tabs while keeping separate bridge nonces", async () => {
    queryClient = new QueryClient();
    await act(async () => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient },
        createElement(NativeFrame, baseProps as any),
        createElement(NativeFrame, { ...baseProps, mode: "statistics" } as any)));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const views = renderer!.root.findAllByType("RNCWebView" as any);
    expect(views).toHaveLength(2);
    expect(mocks.rpc.mock.calls.filter(([request]) => request.route === "ui.document")).toHaveLength(1);
    expect(views[0].props.source.html).not.toBe(views[1].props.source.html);
  });

  test("Android bridges local history events, recovers ACK on malformed payloads, and reassembles chunks", async () => {
    mocks.platform.OS = "android";
    const root = await mount();
    const view = root.findByType("RNCWebView" as any);
    expect(view.props.source.html).toContain('__PASEO_CONTEXT_TRANSPORT__="history"');
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(view.props.source.html)![1];
    const message = { type: "paseo-context:rpc", nonce, id: 1, route: "bootstrap", payload: {} };
    await act(async () => view.props.onLoadingStart({ nativeEvent: {
      url: `about:blank#paseo-context=1:${encodeURIComponent(JSON.stringify(message))}`,
    } }));
    expect(mocks.rpc).toHaveBeenCalledWith({ route: "bootstrap", payload: {} });
    expect(mocks.dispatch).toHaveBeenCalledWith(7, "injectJavaScript", [expect.stringContaining("__PASEO_CONTEXT_ACK__")]);
    expect(mocks.dispatch).toHaveBeenCalledWith(7, "injectJavaScript", [expect.stringContaining('"type":"paseo-context:result"')]);

    // Malformed percent encoding (truncated URL) MUST still send ACK so queue never deadlocks.
    mocks.dispatch.mockClear();
    await act(async () => view.props.onLoadingStart({ nativeEvent: {
      url: `${view.props.source.baseUrl}#paseo-context=2:%E0%A4%A`,
    } }));
    expect(mocks.dispatch).toHaveBeenCalledWith(7, "injectJavaScript", [expect.stringContaining("__PASEO_CONTEXT_ACK__")]);

    // Multi-chunk reassembly over history bridge.
    mocks.dispatch.mockClear();
    mocks.rpc.mockClear();
    const encoded = encodeURIComponent(JSON.stringify({ type: "paseo-context:rpc", nonce, id: 9, route: "bootstrap", payload: { long: "abcdef" } }));
    const mid = Math.floor(encoded.length / 2);
    await act(async () => view.props.onLoadingStart({ nativeEvent: {
      url: `${view.props.source.baseUrl}#paseo-context-chunk=3:1:0:2:${encoded.slice(0, mid)}`,
    } }));
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledWith(7, "injectJavaScript", [expect.stringContaining("__PASEO_CONTEXT_ACK__")]);
    await act(async () => view.props.onLoadingStart({ nativeEvent: {
      url: `data:text/html;charset=utf-8;base64,#paseo-context-chunk=4:1:1:2:${encoded.slice(mid)}`,
    } }));
    expect(mocks.rpc).toHaveBeenCalledWith({ route: "bootstrap", payload: { long: "abcdef" } });
    expect(mocks.dispatch).toHaveBeenCalledWith(7, "injectJavaScript", [expect.stringContaining('"id":9')]);
  });

  test("handles settings error state with reload and close controls, and keeps WebView alive on non-fatal runtime errors", async () => {
    const onClose = vi.fn();
    mocks.settings.status = "error";
    mocks.settings.error = "Settings unreachable";
    const root = await mount({ onClose });
    expect(root.findAllByType("RNCWebView" as any)).toHaveLength(0);
    const buttons = root.findAllByType("Pressable" as any);
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0].props.onPress());
    expect(mocks.settings.reload).toHaveBeenCalledOnce();
    const afterReloadButtons = root.findAllByType("Pressable" as any);
    await act(async () => afterReloadButtons[1].props.onPress());
    expect(onClose).toHaveBeenCalledOnce();

    // Non-fatal paseo-context:error reports ui.error without unmounting RNCWebView.
    await act(async () => renderer!.unmount());
    renderer = null;
    mocks.settings.status = "ready";
    mocks.settings.error = undefined;
    const liveRoot = await mount();
    const view = liveRoot.findByType("RNCWebView" as any);
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(view.props.source.html)![1];
    await act(async () => view.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "paseo-context:error", nonce, message: "Async failure" }) } }));
    expect(mocks.rpc).toHaveBeenCalledWith({ route: "ui.error", payload: { message: "Async failure" } });
    expect(liveRoot.findAllByType("RNCWebView" as any)).toHaveLength(1);
  });

  test("late RPC resolution after unmount never injects JavaScript, and preview allows clipboard.write", async () => {
    let finish!: (value: unknown) => void;
    mocks.rpc.mockImplementation(async (input: { route: string }) => {
      if (input.route === "ui.document") return '<script>globalThis.__PASEO_CONTEXT_NONCE__="%%PASEO_CONTEXT_NONCE%%";</script>';
      if (input.route === "slow") return new Promise((resolve) => { finish = resolve; });
      return { ok: true };
    });
    const root = await mount({
      preview: { values: { defaultPlacement: "all", fleetTab: true }, onSelectAgent: vi.fn(), onSelectPage: vi.fn() },
    });
    const view = root.findByType("RNCWebView" as any);
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(view.props.source.html)![1];
    await act(async () => view.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "paseo-context:rpc", nonce, id: 5, route: "clipboard.write", payload: { text: "copied" } }) } }));
    expect(mocks.copyText).toHaveBeenCalledWith("copied");
    expect(mocks.previewRpc).not.toHaveBeenCalled();

    // Test unmount suppresses late RPC result injection.
    await act(async () => renderer!.unmount());
    renderer = null;
    const normalRoot = await mount();
    const normalView = normalRoot.findByType("RNCWebView" as any);
    const normalNonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(normalView.props.source.html)![1];
    mocks.dispatch.mockClear();
    await act(async () => normalView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "paseo-context:rpc", nonce: normalNonce, id: 77, route: "slow", payload: {} }) } }));
    await act(async () => renderer!.unmount());
    renderer = null;
    finish({ late: true });
    await Promise.resolve();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  test("Android history bridge passes seq to ACK and deduplicates retried RPC frames", async () => {
    mocks.platform.OS = "android";
    const root = await mount();
    const view = root.findByType("RNCWebView" as any);
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(view.props.source.html)![1];
    const encoded = encodeURIComponent(JSON.stringify({ type: "paseo-context:rpc", nonce, id: 88, route: "clipboard.write", payload: { text: "once" } }));
    mocks.dispatch.mockClear();
    mocks.copyText.mockClear();
    await act(async () => view.props.onLoadingStart({ nativeEvent: { url: `${view.props.source.baseUrl}#paseo-context=11:${encoded}` } }));
    await act(async () => view.props.onLoadingStart({ nativeEvent: { url: `${view.props.source.baseUrl}#paseo-context=12:${encoded}` } }));
    expect(mocks.copyText).toHaveBeenCalledTimes(1);
    const injected = mocks.dispatch.mock.calls.map(([, , args]) => args[0]);
    expect(injected.some((script) => script.includes('__PASEO_CONTEXT_ACK__?.("11")'))).toBe(true);
    expect(injected.some((script) => script.includes('__PASEO_CONTEXT_ACK__?.("12")'))).toBe(true);
  });

  test("Android delivers bridge frames mirrored in title when loadDataWithBaseURL strips URL hash", async () => {
    mocks.platform.OS = "android";
    const root = await mount();
    const view = root.findByType("RNCWebView" as any);
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(view.props.source.html)![1];
    const encoded1 = encodeURIComponent(JSON.stringify({ type: "paseo-context:rpc", nonce, id: 91, route: "clipboard.write", payload: { text: "from-title-start" } }));
    const encoded2 = encodeURIComponent(JSON.stringify({ type: "paseo-context:rpc", nonce, id: 92, route: "clipboard.write", payload: { text: "from-title-finish" } }));
    mocks.dispatch.mockClear();
    mocks.copyText.mockClear();

    await act(async () => view.props.onLoadingStart({
      nativeEvent: { url: "data:text/html;charset=utf-8;base64,", title: `#paseo-context=21:${encoded1}` },
    }));
    await act(async () => view.props.onLoadingFinish({
      nativeEvent: { url: "data:text/html;charset=utf-8;base64,", title: `#paseo-context=22:${encoded2}` },
    }));
    expect(mocks.copyText).toHaveBeenCalledWith("from-title-start");
    expect(mocks.copyText).toHaveBeenCalledWith("from-title-finish");
    const injected = mocks.dispatch.mock.calls.map(([, , args]) => args[0]);
    expect(injected.some((script) => script.includes('__PASEO_CONTEXT_ACK__?.("21")'))).toBe(true);
    expect(injected.some((script) => script.includes('__PASEO_CONTEXT_ACK__?.("22")'))).toBe(true);
    expect(injected.some((script) => script.includes("paseo-context:init"))).toBe(false);

    // Newer title seq beats stale retained url hash; duplicate seq across onLoadingProgress is deduplicated.
    const encoded3 = encodeURIComponent(JSON.stringify({ type: "paseo-context:ready", nonce }));
    mocks.dispatch.mockClear();
    await act(async () => view.props.onLoadingProgress({
      nativeEvent: { url: `${view.props.source.baseUrl}#paseo-context=21:${encoded1}`, title: `#paseo-context=23:${encoded3}` },
    }));
    await act(async () => view.props.onLoadingProgress({
      nativeEvent: { url: `${view.props.source.baseUrl}#paseo-context=21:${encoded1}`, title: `#paseo-context=23:${encoded3}` },
    }));
    const progressInjected = mocks.dispatch.mock.calls.map(([, , args]) => args[0]);
    expect(progressInjected.filter((script) => script.includes('__PASEO_CONTEXT_ACK__?.("23")'))).toHaveLength(1);
    expect(progressInjected.filter((script) => script.includes("paseo-context:init"))).toHaveLength(1);
  });

  test("caps active non-overlay native WebViews to 2 via LRU, allows manual resume, and exempts overlay modals", async () => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient },
        createElement(NativeFrame, { ...baseProps, mode: "context" } as any),
        createElement(NativeFrame, { ...baseProps, mode: "fleet" } as any),
        createElement(NativeFrame, { ...baseProps, mode: "statistics" } as any),
        createElement(NativeFrame, { ...baseProps, mode: "modal", overlay: true } as any)));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    // 2 pooled WebViews + 1 overlay WebView = 3 mounted; oldest pooled WebView is paused.
    expect(nativeWebViewPool.activeCount()).toBe(2);
    expect(renderer!.root.findAllByType("RNCWebView" as any)).toHaveLength(3);
    const resumeButton = renderer!.root.findAllByType("Pressable" as any).find((btn) =>
      btn.findAllByType("Text" as any).some((t) => t.children.join("").includes("已暂停以节省内存，点击恢复")));
    expect(resumeButton).toBeDefined();

    // Tapping resume restores the paused tab and evicts the next oldest pooled tab.
    await act(async () => resumeButton!.props.onPress());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(nativeWebViewPool.activeCount()).toBe(2);
    expect(renderer!.root.findAllByType("RNCWebView" as any)).toHaveLength(3);
  });

  test("fast-pauses initial 0x0 layout, delays post-load 0x0 by 5s, and uses iOS 1.5s / Android 30s background pause with active-race guard", async () => {
    vi.useFakeTimers();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient },
        createElement(NativeFrame, { ...baseProps, mode: "context", activationToken: 1 } as any)));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(renderer!.root.findAllByType("RNCWebView" as any)).toHaveLength(1);

    // 1. Before WebView finishes loading, 0x0 layout pauses IMMEDIATELY (fast path, no 5s wait).
    const initialWrapper = renderer!.root.findAllByType("View" as any).find((v) => typeof v.props.onLayout === "function")!;
    await act(async () => {
      initialWrapper.props.onLayout({ nativeEvent: { layout: { width: 0, height: 0 } } });
    });
    expect(renderer!.root.findAllByType("RNCWebView" as any)).toHaveLength(0);
    expect(nativeWebViewPool.activeCount()).toBe(0);

    // Transition back to non-zero layout auto-resumes WebView.
    const pausedWrapper = renderer!.root.findAllByType("View" as any).find((v) => typeof v.props.onLayout === "function")!;
    await act(async () => {
      pausedWrapper.props.onLayout({ nativeEvent: { layout: { width: 390, height: 700 } } });
      await vi.advanceTimersByTimeAsync(10);
    });
    const loadedView = renderer!.root.findByType("RNCWebView" as any);
    await act(async () => loadedView.props.onLoadingFinish({ nativeEvent: {} }));

    // 2. After WebView has rendered, 0x0 waits 5s before pausing.
    const liveWrapper = renderer!.root.findAllByType("View" as any).find((v) => typeof v.props.onLayout === "function")!;
    await act(async () => {
      liveWrapper.props.onLayout({ nativeEvent: { layout: { width: 0, height: 0 } } });
      await vi.advanceTimersByTimeAsync(4900);
    });
    expect(renderer!.root.findAllByType("RNCWebView" as any)).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(renderer!.root.findAllByType("RNCWebView" as any)).toHaveLength(0);

    // Resume via non-zero layout.
    const hiddenWrapper = renderer!.root.findAllByType("View" as any).find((v) => typeof v.props.onLayout === "function")!;
    await act(async () => {
      hiddenWrapper.props.onLayout({ nativeEvent: { layout: { width: 390, height: 700 } } });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(renderer!.root.findAllByType("RNCWebView" as any)).toHaveLength(1);

    // 3. Race guard: if AppState.currentState is already "active" when timer fires, do NOT pause.
    mocks.appStateCurrent = "active";
    await act(async () => {
      for (const fn of mocks.appStateListeners) fn("background");
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(renderer!.root.findAllByType("RNCWebView" as any)).toHaveLength(1);

    // 4. iOS background pauses at 1.5s when currentState is "background", and resumes on "active".
    mocks.appStateCurrent = "background";
    await act(async () => {
      for (const fn of mocks.appStateListeners) fn("background");
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(renderer!.root.findAllByType("RNCWebView" as any)).toHaveLength(0);
    expect(nativeWebViewPool.activeCount()).toBe(0);

    mocks.appStateCurrent = "active";
    await act(async () => {
      for (const fn of mocks.appStateListeners) fn("active");
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(renderer!.root.findAllByType("RNCWebView" as any)).toHaveLength(1);

    // 5. Android background waits 30s (still alive at 1.5s, paused at 30s).
    mocks.platform.OS = "android";
    mocks.appStateCurrent = "background";
    await act(async () => {
      for (const fn of mocks.appStateListeners) fn("background");
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(renderer!.root.findAllByType("RNCWebView" as any)).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(28_500); });
    expect(renderer!.root.findAllByType("RNCWebView" as any)).toHaveLength(0);
  });

  test("Android pause/resume resets history bridge seq/id caches and drops stale pre-pause RPC responses", async () => {
    mocks.platform.OS = "android";
    let resolveStaleRpc!: (value: unknown) => void;
    let callCount = 0;
    mocks.rpc.mockImplementation(async (input: { route: string }) => {
      if (input.route === "ui.document") return '<script>globalThis.__PASEO_CONTEXT_NONCE__="%%PASEO_CONTEXT_NONCE%%";</script>';
      if (input.route === "bootstrap") {
        callCount++;
        if (callCount === 1) return new Promise((resolve) => { resolveStaleRpc = resolve; });
        return { fresh: true };
      }
      return { ok: true };
    });

    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient },
        createElement(NativeFrame, { ...baseProps, mode: "context" } as any),
        createElement(NativeFrame, { ...baseProps, mode: "fleet" } as any)));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    // First WebView (context) receives seq=1 (ready) and seq=2 (rpc id=1, stays in-flight).
    const firstView = renderer!.root.findAllByType("RNCWebView" as any)[0];
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(firstView.props.source.html)![1];
    const readyEncoded = encodeURIComponent(JSON.stringify({ type: "paseo-context:ready", nonce }));
    const rpcEncoded = encodeURIComponent(JSON.stringify({ type: "paseo-context:rpc", nonce, id: 1, route: "bootstrap", payload: {} }));

    await act(async () => firstView.props.onLoadingStart({ nativeEvent: { url: `${firstView.props.source.baseUrl}#paseo-context=1:${readyEncoded}` } }));
    await act(async () => firstView.props.onLoadingStart({ nativeEvent: { url: `${firstView.props.source.baseUrl}#paseo-context=2:${rpcEncoded}` } }));

    // Mount a 3rd pooled tab so the 1st tab (context) is LRU-paused while rpc id=1 is still pending.
    await act(async () => {
      renderer!.update(createElement(QueryClientProvider, { client: queryClient },
        createElement(NativeFrame, { ...baseProps, mode: "context" } as any),
        createElement(NativeFrame, { ...baseProps, mode: "fleet" } as any),
        createElement(NativeFrame, { ...baseProps, mode: "statistics" } as any)));
    });
    const resumeBtn = renderer!.root.findAllByType("Pressable" as any).find((btn) =>
      btn.findAllByType("Text" as any).some((t) => t.children.join("").includes("已暂停以节省内存，点击恢复")))!;
    await act(async () => resumeBtn.props.onPress());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    // Pre-pause stale RPC resolves AFTER resume -> MUST NOT inject stale result into new WebView.
    mocks.dispatch.mockClear();
    await act(async () => { resolveStaleRpc({ stale: true }); await Promise.resolve(); });
    expect(mocks.dispatch.mock.calls.some(([, , args]) => String(args[0]).includes('"stale":true'))).toBe(false);

    // Resumed Android WebView restarts history seq from 1 (ready) and rpc id from 1 -> MUST be accepted & ACKed!
    const resumedView = renderer!.root.findAllByType("RNCWebView" as any)[0];
    mocks.dispatch.mockClear();
    await act(async () => resumedView.props.onLoadingStart({ nativeEvent: { url: `${resumedView.props.source.baseUrl}#paseo-context=1:${readyEncoded}` } }));
    await act(async () => resumedView.props.onLoadingStart({ nativeEvent: { url: `${resumedView.props.source.baseUrl}#paseo-context=2:${rpcEncoded}` } }));
    const scripts = mocks.dispatch.mock.calls.map(([, , args]) => String(args[0]));
    expect(scripts.some((s) => s.includes('__PASEO_CONTEXT_ACK__?.("1")'))).toBe(true);
    expect(scripts.some((s) => s.includes("paseo-context:init"))).toBe(true);
    expect(scripts.some((s) => s.includes('__PASEO_CONTEXT_ACK__?.("2")'))).toBe(true);
    expect(scripts.some((s) => s.includes('"fresh":true'))).toBe(true);
  });

  test("expires incomplete Android chunk groups after 30s and caps concurrent chunk groups at 4", async () => {
    vi.useFakeTimers();
    mocks.platform.OS = "android";
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      renderer = create(createElement(QueryClientProvider, { client: queryClient },
        createElement(NativeFrame, baseProps as any)));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const view = renderer!.root.findByType("RNCWebView" as any);
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(view.props.source.html)![1];
    const encoded = encodeURIComponent(JSON.stringify({ type: "paseo-context:rpc", nonce, id: 501, route: "bootstrap", payload: { k: "v" } }));
    const mid = Math.floor(encoded.length / 2);

    mocks.rpc.mockClear();
    // Send part 0/2 of group 10, then wait 30s so it expires.
    await act(async () => view.props.onLoadingStart({
      nativeEvent: { url: `${view.props.source.baseUrl}#paseo-context-chunk=100:10:0:2:${encoded.slice(0, mid)}` },
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    // Now part 1/2 arrives alone -> group 10 expired, so bootstrap RPC must NOT fire.
    await act(async () => view.props.onLoadingStart({
      nativeEvent: { url: `${view.props.source.baseUrl}#paseo-context-chunk=101:10:1:2:${encoded.slice(mid)}` },
    }));
    expect(mocks.rpc).not.toHaveBeenCalledWith({ route: "bootstrap", payload: { k: "v" } });

    // Start 5 incomplete groups (g1..g5); MAX_CHUNK_GROUPS=4 evicts g1.
    for (let g = 1; g <= 5; g++) {
      await act(async () => view.props.onLoadingStart({
        nativeEvent: { url: `${view.props.source.baseUrl}#paseo-context-chunk=${200 + g}:g${g}:0:2:${encoded.slice(0, mid)}` },
      }));
    }
    // Sending part 1/2 for evicted g1 does not complete, while g5 completes normally.
    await act(async () => view.props.onLoadingStart({
      nativeEvent: { url: `${view.props.source.baseUrl}#paseo-context-chunk=210:g1:1:2:${encoded.slice(mid)}` },
    }));
    expect(mocks.rpc).not.toHaveBeenCalledWith({ route: "bootstrap", payload: { k: "v" } });
    await act(async () => view.props.onLoadingStart({
      nativeEvent: { url: `${view.props.source.baseUrl}#paseo-context-chunk=211:g5:1:2:${encoded.slice(mid)}` },
    }));
    expect(mocks.rpc).toHaveBeenCalledWith({ route: "bootstrap", payload: { k: "v" } });
  });
});
