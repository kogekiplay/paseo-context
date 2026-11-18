import { act, create } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  platform: { OS: "ios" }, dispatch: vi.fn(), navigation: vi.fn(),
  module: { shouldStartLoadWithLockIdentifier: vi.fn() },
  rpc: vi.fn(async (input: { route: string }) => input.route === "ui.document"
    ? '<script>globalThis.__PASEO_CONTEXT_NONCE__="%%PASEO_CONTEXT_NONCE%%";</script>'
    : { sessions: [], selected: null }),
  settings: { status: "ready", revision: "one", values: { defaultPlacement: "all", fleetTab: true }, save: vi.fn(async () => true) },
}));
vi.mock("react-native", () => ({
  Platform: mocks.platform, View: "View", Text: "Text", Linking: { openURL: mocks.navigation },
  UIManager: { dispatchViewManagerCommand: mocks.dispatch }, findNodeHandle: () => 7,
  TurboModuleRegistry: { get: () => mocks.module },
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => mocks.rpc, useSettings: () => mocks.settings,
  useTranslation: () => ({ locale: "zh-CN", t: () => "上下文" }),
  defineTranslations: (value: unknown) => value,
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  copyText: vi.fn(async () => {}),
  Modal: Object.assign("Modal", { Content: "Content" }),
}));
import { NativeFrame } from "../client/native";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReturnType<typeof create> | null = null;
let queryClient: QueryClient;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  queryClient?.clear();
  renderer = null; vi.clearAllMocks(); mocks.platform.OS = "ios";
});
const props = { mode: "insights" as const, theme: { colors: { surface0: "#111111", foreground: "#ffffff", foregroundMuted: "#aaaaaa" } },
  host: { id: "host", label: "Host" }, layout: { compact: true, platform: "ios" as const },
  openSettings: vi.fn(), openContext: vi.fn() };
async function mount() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { renderer = create(createElement(QueryClientProvider, { client: queryClient },
    createElement(NativeFrame, props as any))); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return renderer!.root.findByType("RNCWebView" as any);
}
describe("Native upstream UI container", () => {
  test("iPad receives the actual HTML and completes the nonce-checked initialization", async () => {
    const view = await mount();
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(view.props.source.html)![1];
    expect(view.props.javaScriptEnabled).toBe(true);
    expect(view.props.newSource).toBe(view.props.source);
    await act(async () => view.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "paseo-context:ready", nonce }) } }));
    expect(mocks.dispatch).toHaveBeenCalledWith(7, "injectJavaScript", [expect.stringContaining('"type":"paseo-context:init"')]);
    expect(mocks.rpc).toHaveBeenCalledWith({ route: "ui.status", payload: { phase: "JavaScript ready", platform: "ios" } });
    mocks.dispatch.mockClear();
    await act(async () => view.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "paseo-context:ready", nonce: "other" }) } }));
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  test("blocks navigation away from the bundled local document", async () => {
    const view = await mount();
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
    await act(async () => { renderer = create(createElement(QueryClientProvider, { client: queryClient },
      createElement(NativeFrame, props as any),
      createElement(NativeFrame, { ...props, mode: "statistics" } as any))); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const views = renderer!.root.findAllByType("RNCWebView" as any);
    expect(views).toHaveLength(2);
    expect(mocks.rpc.mock.calls.filter(([request]) => request.route === "ui.document")).toHaveLength(1);
    expect(views[0].props.source.html).not.toBe(views[1].props.source.html);
  });
  test("Android bridges local history events without replacing Paseo's global WebView emitter", async () => {
    mocks.platform.OS = "android";
    const view = await mount();
    expect(view.props.source.html).toContain('__PASEO_CONTEXT_TRANSPORT__="history"');
    const nonce = /__PASEO_CONTEXT_NONCE__="([^"]+)"/.exec(view.props.source.html)![1];
    const message = { type: "paseo-context:rpc", nonce, id: 1, route: "bootstrap", payload: {} };
    await act(async () => view.props.onLoadingStart({ nativeEvent: {
      url: `about:blank#paseo-context=1:${encodeURIComponent(JSON.stringify(message))}`,
    } }));
    expect(mocks.rpc).toHaveBeenCalledWith({ route: "bootstrap", payload: {} });
    expect(mocks.dispatch).toHaveBeenCalledWith(7, "injectJavaScript", [expect.stringContaining("__PASEO_CONTEXT_ACK__")]);
    expect(mocks.dispatch).toHaveBeenCalledWith(7, "injectJavaScript", [expect.stringContaining('"type":"paseo-context:result"')]);
    mocks.dispatch.mockClear();
    await act(async () => view.props.onLoadingStart({ nativeEvent: {
      url: `data:text/html;charset=utf-8;base64,#paseo-context=2:${encodeURIComponent(JSON.stringify(message))}`,
    } }));
    expect(mocks.dispatch).not.toHaveBeenCalledWith(7, "stopLoading", []);
    expect(mocks.dispatch).toHaveBeenCalledWith(7, "injectJavaScript", [expect.stringContaining('"type":"paseo-context:result"')]);
  });
});
