import { createElement, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { findNodeHandle, Linking, Platform, Text, TurboModuleRegistry, UIManager, View } from "react-native";
import type { TurboModule } from "react-native";
import { useRpc, useSettings, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Modal } from "@getpaseo/plugin/client/ui";
import { bridgeRpc } from "../shared/bridge";
import { preferences } from "../shared/contracts";
import { messages } from "./messages";
import { useQuery } from "@tanstack/react-query";
import { uiRevision } from "../shared/generated/ui-revision";
import { isNativeDocumentUrl, isNativeLoadEventUrl, nativeDocumentUrl } from "./native-navigation";

type Props = PluginSurfaceProps & {
  mode: "context" | "fleet" | "statistics" | "insights" | "settings" | "modal";
  agentId?: string; overlay?: boolean; onClose?: () => void;
  openSettings: () => void; openContext: (agentId: string) => void;
};
interface WebViewModule extends TurboModule {
  shouldStartLoadWithLockIdentifier(allow: boolean, lock: number): void;
}
// Paseo 0.15.4 imports react-native-webview 13.16.1 for its document viewer.
// Its codegen component is already registered; reuse that host registration.
// Registering it again with requireNativeComponent would cause a duplicate view.
const RNCWebView = "RNCWebView" as unknown as ComponentType<any>;
const originalPreferences = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) =>
  [key, typeof value === "boolean" ? value ? "show" : "hide" : value]));

export function NativeFrame(props: Props) {
  const { t } = useTranslation(messages);
  const content = <NativeFrameBody {...props} />;
  return props.overlay ? <Modal title={t("context")} open onOpenChange={(open) => { if (!open) props.onClose?.(); }}>
    <Modal.Content scrollable={false} style={{ flex: 1 }} contentContainerStyle={{ padding: 0, gap: 0, flex: 1 }}>{content}</Modal.Content>
  </Modal> : content;
}
function NativeFrameBody(props: Props) {
  const rpc = useRpc(bridgeRpc), settings = useSettings(preferences), { locale } = useTranslation(messages);
  const ref = useRef<any>(null), mounted = useRef(true), reported = useRef(new Set<string>());
  const latest = useRef({ props, settings, locale, rpc });
  latest.current = { props, settings, locale, rpc };
  const nonce = useMemo(() => `native${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`, []);
  const baseUrl = useMemo(() => nativeDocumentUrl(nonce), [nonce]);
  const [html, setHtml] = useState(""), [error, setError] = useState("");
  // Paseo supplies a query client per installation/host. All three tabs reuse
  // the static document without sharing session data across connections.
  const markupQuery = useQuery({
    queryKey: ["paseo-context", "ui.document", uiRevision], staleTime: Infinity, gcTime: 120000,
    queryFn: async () => {
      const value = await rpc({ route: "ui.document", payload: {} });
      if (typeof value !== "string") throw new Error("Invalid UI document");
      return value;
    },
  });
  const report = (phase: string) => {
    if (reported.current.has(phase)) return;
    reported.current.add(phase);
    void latest.current.rpc({ route: "ui.status", payload: { phase, platform: Platform.OS } }).catch(() => {});
  };
  const inject = (script: string) => {
    const tag = findNodeHandle(ref.current);
    if (tag === null) return;
    UIManager.dispatchViewManagerCommand(tag, "injectJavaScript", [script]);
  };
  const send = (data: unknown) => inject(`globalThis.__PASEO_CONTEXT_RECEIVE__?.(${JSON.stringify(data)});true;`);
  const initialize = () => {
    const { props, settings, locale } = latest.current;
    if (settings.status !== "ready") return;
    const hex = props.theme.colors.surface0.replace("#", "");
    const rgb = hex.length === 3 ? hex.split("").map((c) => parseInt(c + c, 16))
      : [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
    send({ type: "paseo-context:init", nonce, agentId: props.agentId ?? "", mode: props.mode, locale,
      preferences: originalPreferences(settings.values), dark: rgb.reduce((n, c) => n + c, 0) / 3 < 128 });
  };
  useEffect(() => {
    mounted.current = true;
    report("mounted");
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (markupQuery.error) setError(markupQuery.error.message);
    if (!markupQuery.data) return;
    const markup = markupQuery.data.replaceAll("%%PASEO_CONTEXT_NONCE%%", nonce);
    setHtml(Platform.OS === "android" ? markup.replace("globalThis.__PASEO_CONTEXT_NONCE__=",
      'globalThis.__PASEO_CONTEXT_TRANSPORT__="history";globalThis.__PASEO_CONTEXT_NONCE__=') : markup);
  }, [markupQuery.data, markupQuery.error, nonce]);
  useEffect(initialize, [settings.status === "ready" ? settings.revision : "", locale, props.mode, props.agentId, props.theme.colors.surface0]);
  const receive = (event: { nativeEvent: { data: string } }) => {
    if (!mounted.current) return;
    let data: any;
    try { data = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (data?.nonce !== nonce) return;
    if (data.type === "paseo-context:ready") { report("JavaScript ready"); initialize(); return; }
    if (data.type === "paseo-context:status") { report("rendered"); return; }
    if (data.type === "paseo-context:fatal") { setError(String(data.message)); report("JavaScript error"); return; }
    if (data.type === "paseo-context:action") {
      if (data.name === "openSettings") latest.current.props.openSettings();
      else if (data.name === "close") latest.current.props.onClose?.();
      else if (data.name === "openAgent") {
        const id = String(data.payload?.agentId ?? "");
        if (id.startsWith("native:")) latest.current.props.openContext(id);
        else latest.current.props.navigation?.openAgent({ agentId: id });
      } else if (data.name === "openExternal" && /^https?:\/\//.test(String(data.payload?.url))) void Linking.openURL(data.payload.url);
      return;
    }
    if (data.type !== "paseo-context:rpc") return;
    const reply = (value: unknown, error?: string) => {
      if (mounted.current) send({ type: "paseo-context:result", nonce, id: data.id, value, error });
    };
    void (async () => {
      try {
        const { settings, rpc } = latest.current;
        if (data.route === "clipboard.write") { await copyText(String(data.payload?.text ?? "")); reply(true); return; }
        if (data.route === "settings.set") {
          if (settings.status !== "ready") throw new Error("Preferences are not ready");
          const key = String(data.payload?.field);
          if (!(key in settings.values)) throw new Error("Unknown preference");
          const value = typeof settings.values[key as keyof typeof settings.values] === "boolean" ? data.payload?.value === "show" : data.payload?.value;
          const next = { ...settings.values, [key]: value };
          if (!await settings.save(next, settings.revision)) throw new Error("Could not save preferences; reload and retry");
          reply(originalPreferences(next)); return;
        }
        reply(await rpc({ route: String(data.route), payload: data.payload }));
      } catch (error) { reply(null, error instanceof Error ? error.message : String(error)); }
    })();
  };
  // Android's WebView may expose loadDataWithBaseURL("about:blank") as a
  // data: URL; a unique HTTPS origin avoids that alias and also supports
  // same-document replaceState. The HTML is still supplied locally, not fetched.
  const source = useMemo(() => ({ html, baseUrl }), [html, baseUrl]);
  if (error) return <View style={{ padding: 24 }}><Text style={{ color: props.theme.colors.foreground }}>Paseo Context: {error}</Text></View>;
  if (!html) return <View style={{ padding: 24 }}><Text style={{ color: props.theme.colors.foregroundMuted }}>{locale.startsWith("zh") ? "正在加载原版界面…" : "Loading interface…"}</Text></View>;
  return createElement(RNCWebView, {
    ref, source, newSource: source, style: { flex: 1, backgroundColor: props.theme.colors.surface0 },
    javaScriptEnabled: true, messagingEnabled: true, messagingModuleName: "",
    onMessage: receive, onLoadingFinish: (event: { nativeEvent: { title?: string } }) => {
      if (event.nativeEvent.title?.startsWith("Paseo Context error:")) {
        setError(event.nativeEvent.title); report(event.nativeEvent.title.slice(0, 150));
      }
      report("document loaded"); initialize();
    },
    // Android routes WebView.postMessage through a host-owned JS emitter which
    // plugins cannot subscribe to. Local same-document history events use the
    // native view's direct event channel and never load a network URL.
    onLoadingStart: (event: { nativeEvent: { url: string } }) => {
      if (!isNativeLoadEventUrl(event.nativeEvent.url, baseUrl, Platform.OS === "android")) {
        const tag = findNodeHandle(ref.current);
        if (tag !== null) UIManager.dispatchViewManagerCommand(tag, "stopLoading", []);
        setError("Navigation outside the bundled interface was blocked.");
        const scheme = /^[a-z]+(?=:)/i.exec(event.nativeEvent.url)?.[0] ?? "unknown";
        report(`unexpected navigation blocked (${scheme})`); return;
      }
      const marker = "#paseo-context=";
      const at = event.nativeEvent.url.indexOf(marker);
      report(at < 0 ? "navigation started" : "history bridge ready");
      if (at < 0) return;
      const value = event.nativeEvent.url.slice(at + marker.length);
      const colon = value.indexOf(":");
      if (colon < 1) return;
      let message: string;
      try { message = decodeURIComponent(value.slice(colon + 1)); } catch { return; }
      receive({ nativeEvent: { data: message } });
      inject("globalThis.__PASEO_CONTEXT_ACK__?.();true;");
    },
    onLoadingError: (event: { nativeEvent: { description?: string } }) => setError(event.nativeEvent.description ?? "Could not load the UI"),
    onShouldStartLoadWithRequest: (event: { nativeEvent: { url: string; lockIdentifier: number } }) => {
      const { url, lockIdentifier } = event.nativeEvent;
      TurboModuleRegistry.get<WebViewModule>("RNCWebViewModule")?.shouldStartLoadWithLockIdentifier(isNativeDocumentUrl(url, baseUrl), lockIdentifier);
    },
    cacheEnabled: false, incognito: true, domStorageEnabled: false,
    thirdPartyCookiesEnabled: false, setSupportMultipleWindows: false,
    javaScriptCanOpenWindowsAutomatically: false,
    automaticallyAdjustContentInsets: false, contentInsetAdjustmentBehavior: "never",
  });
}
