import { createElement, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { findNodeHandle, Linking, Platform, Pressable, Text, TurboModuleRegistry, UIManager, View } from "react-native";
import type { TurboModule } from "react-native";
import { useRpc, useSettings, useTranslation } from "@getpaseo/plugin/client";
import { copyText, Modal } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { bridgeRpc, settingsPreviewRpc } from "../shared/bridge";
import { preferences } from "../shared/contracts";
import {
  buildInitPayload, createSettingsSaver, handleBridgeAction, handleBridgeRpc,
  platformNameOf, uiDocumentQueryOptions,
} from "./bridge-shared";
import type { FrameProps } from "./frame";
import { messages } from "./messages";
import { isNativeDocumentUrl, isNativeLoadEventUrl, nativeDocumentUrl } from "./native-navigation";

interface WebViewModule extends TurboModule {
  shouldStartLoadWithLockIdentifier(allow: boolean, lock: number): void;
}
interface ChunkBuffer { total: number; parts: Array<string | undefined>; received: number }

// Paseo 0.15.4 imports react-native-webview 13.16.1 for its native view.
// Its codegen component is already registered; reuse that host registration.
// Registering it again with requireNativeComponent would cause a duplicate view.
const RNCWebView = "RNCWebView" as unknown as ComponentType<any>;
const MAX_CHUNK_GROUPS = 16;
const MAX_CHUNKS_PER_MESSAGE = 256;
const MAX_COMPLETED_GROUPS = 128;
const MAX_SEEN_HISTORY_IDS = 256;

function rememberBounded(set: Set<string>, key: string, limit: number) {
  set.delete(key);
  set.add(key);
  while (set.size > limit) set.delete(set.values().next().value!);
}

export function NativeFrame(props: FrameProps) {
  const { t } = useTranslation(messages);
  const content = <NativeFrameHost {...props} />;
  return props.overlay ? <Modal title={t("context")} open onOpenChange={(open) => { if (!open) props.onClose?.(); }}>
    <Modal.Content scrollable={false} style={{ flex: 1 }} contentContainerStyle={{ padding: 0, gap: 0, flex: 1 }}>{content}</Modal.Content>
  </Modal> : content;
}

function NativeFrameHost(props: FrameProps) {
  const [attempt, setAttempt] = useState(0);
  return <NativeFrameBody {...props} key={attempt} retry={() => setAttempt((value) => value + 1)} />;
}

function NativeFrameBody(props: FrameProps & { retry: () => void }) {
  const rpc = useRpc(bridgeRpc);
  const previewRpc = useRpc(settingsPreviewRpc);
  const settings = useSettings(preferences);
  const { locale } = useTranslation(messages);
  const ref = useRef<any>(null);
  const mounted = useRef(true);
  const reported = useRef(new Set<string>());
  const chunks = useRef(new Map<string, ChunkBuffer>());
  const completedGroups = useRef(new Set<string>());
  const seenHistoryIds = useRef(new Set<string>());
  const latest = useRef({ props, settings, locale, rpc, previewRpc });
  latest.current = { props, settings, locale, rpc, previewRpc };
  const saveSetting = useMemo(() => createSettingsSaver(() => latest.current.settings as any), []);
  const nonce = useMemo(() => `native${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`, []);
  const baseUrl = useMemo(() => nativeDocumentUrl(nonce), [nonce]);
  const platform = platformNameOf(Platform.OS);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);

  // Paseo supplies a query client per installation/host. All tabs reuse
  // the static markup without sharing session data across connections.
  const markupQuery = useQuery(uiDocumentQueryOptions(rpc));
  const html = useMemo(() => {
    if (!markupQuery.data) return "";
    const markup = markupQuery.data.replaceAll("%%PASEO_CONTEXT_NONCE%%", nonce);
    return Platform.OS === "android"
      ? markup.replace("globalThis.__PASEO_CONTEXT_NONCE__=", 'globalThis.__PASEO_CONTEXT_TRANSPORT__="history";globalThis.__PASEO_CONTEXT_NONCE__=')
      : markup;
  }, [markupQuery.data, nonce]);

  const chinese = locale.startsWith("zh");
  const docError = markupQuery.error ? (markupQuery.error instanceof Error ? markupQuery.error.message : String(markupQuery.error)) : "";
  const loaded = ready && Boolean(html) && (!!props.preview || settings.status === "ready");
  const settingsError = !props.preview && (settings.status === "error" || settings.status === "invalid")
    ? (settings.error || (chinese ? "无法读取设置" : "Preferences unavailable")) : "";
  const failure = error || docError || settingsError;
  const failed = Boolean(failure);

  const report = (phase: string) => {
    if (latest.current.props.preview || reported.current.has(phase)) return;
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
    const values = props.preview?.values ?? (settings.status === "ready" ? settings.values : null);
    if (!values) return;
    send(buildInitPayload(props, values, nonce, locale, platformNameOf(Platform.OS)));
  };

  useEffect(() => {
    mounted.current = true;
    report("mounted");
    return () => {
      mounted.current = false;
      chunks.current.clear();
      completedGroups.current.clear();
      seenHistoryIds.current.clear();
    };
  }, []);

  useEffect(() => {
    if (markupQuery.data && !markupQuery.error && error) setError("");
  }, [markupQuery.data, markupQuery.error]);

  useEffect(initialize, [
    settings.status,
    settings.status === "ready" ? settings.revision : "",
    props.preview?.values,
    locale,
    props.mode,
    props.agentId,
    props.theme.colors.surface0,
    platform,
  ]);

  useEffect(() => {
    if (loaded || failed) return;
    const timer = setTimeout(() => setSlow(true), 15000);
    return () => clearTimeout(timer);
  }, [loaded, failed]);

  const receive = (event: { nativeEvent: { data: string } }) => {
    if (!mounted.current) return;
    let data: any;
    try { data = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (data?.nonce !== nonce) return;
    if (data.type === "paseo-context:ready") { setSlow(false); setReady(true); report("JavaScript ready"); initialize(); return; }
    if (data.type === "paseo-context:status") { report("rendered"); return; }
    if (data.type === "paseo-context:fatal") { setError(String(data.message)); report("JavaScript error"); return; }
    if (data.type === "paseo-context:error") {
      if (!latest.current.props.preview) {
        void latest.current.rpc({ route: "ui.error", payload: { message: String(data.message ?? "") } }).catch(() => {});
      }
      return;
    }
    if (data.type === "paseo-context:action") {
      handleBridgeAction(data, latest.current.props, (url) => { void Linking.openURL(url); });
      return;
    }
    if (data.type !== "paseo-context:rpc") return;
    const reply = (value: unknown, err?: string) => {
      if (mounted.current) send({ type: "paseo-context:result", nonce, id: data.id, value, error: err });
    };
    void (async () => {
      try {
        const { props, rpc, previewRpc } = latest.current;
        const value = await handleBridgeRpc(data, { props, rpc, previewRpc, saveSetting, copyText });
        reply(value);
      } catch (err) { reply(null, err instanceof Error ? err.message : String(err)); }
    })();
  };

  const receiveHistory = (message: string) => {
    let data: any;
    try { data = JSON.parse(message); } catch { return; }
    if (data?.nonce !== nonce) return;
    const dedupeKey = data.type === "paseo-context:rpc" && data.id !== undefined
      ? `rpc:${data.id}`
      : data.type === "paseo-context:action" && data.aid !== undefined
        ? `act:${data.aid}`
        : "";
    if (dedupeKey) {
      if (seenHistoryIds.current.has(dedupeKey)) return;
      rememberBounded(seenHistoryIds.current, dedupeKey, MAX_SEEN_HISTORY_IDS);
    }
    receive({ nativeEvent: { data: message } });
  };

  const handleChunkFrame = (raw: string) => {
    // Format: <seq>:<groupId>:<index>:<total>:<encodedPart>
    const first = raw.indexOf(":");
    const second = first < 0 ? -1 : raw.indexOf(":", first + 1);
    const third = second < 0 ? -1 : raw.indexOf(":", second + 1);
    const fourth = third < 0 ? -1 : raw.indexOf(":", third + 1);
    if (first < 1 || second < 0 || third < 0 || fourth < 0) return;
    const groupId = raw.slice(first + 1, second);
    const index = Number(raw.slice(second + 1, third));
    const total = Number(raw.slice(third + 1, fourth));
    if (!groupId || !Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > MAX_CHUNKS_PER_MESSAGE || index < 0 || index >= total) return;
    if (completedGroups.current.has(groupId)) return;
    const part = raw.slice(fourth + 1);
    let entry = chunks.current.get(groupId);
    if (!entry || entry.total !== total) {
      while (chunks.current.size >= MAX_CHUNK_GROUPS) chunks.current.delete(chunks.current.keys().next().value!);
      entry = { total, parts: Array.from({ length: total }), received: 0 };
      chunks.current.set(groupId, entry);
    }
    if (entry.parts[index] === undefined) entry.received++;
    entry.parts[index] = part;
    if (entry.received < entry.total) return;
    chunks.current.delete(groupId);
    rememberBounded(completedGroups.current, groupId, MAX_COMPLETED_GROUPS);
    const combined = entry.parts.join("");
    const message = decodeURIComponent(combined);
    receiveHistory(message);
  };

  // Android's WebView may expose loadDataWithBaseURL("about:blank") as a
  // data: URL; a unique HTTPS origin avoids that alias and also supports
  // same-origin history state updates. The HTML is supplied locally, not fetched.
  const source = useMemo(() => ({ html, baseUrl }), [html, baseUrl]);
  const accent = props.theme.colors.accent ?? props.theme.colors.foreground;

  const statusBanner = !loaded || failed ? <View style={{ padding: 24, gap: 10, backgroundColor: props.theme.colors.surface0 }}>
    <Text accessibilityRole={failed ? "alert" : undefined} style={{ color: failed ? props.theme.colors.foreground : props.theme.colors.foregroundMuted }}>
      {failed ? `Paseo Context: ${failure}` : slow ? (chinese ? "界面加载较慢…" : "The interface is taking longer than usual…") : (chinese ? "正在加载原版界面…" : "Loading interface…")}
    </Text>
    {failed || slow ? <Pressable accessibilityRole="button" onPress={() => {
      setError("");
      if (markupQuery.error) void markupQuery.refetch().catch(() => {});
      if (settings.status !== "ready") void settings.reload().catch(() => {});
      props.retry();
    }}>
      <Text style={{ color: accent }}>{chinese ? "重新加载" : "Reload"}</Text>
    </Pressable> : null}
    {props.onClose ? <Pressable accessibilityRole="button" onPress={props.onClose}>
      <Text style={{ color: accent }}>{chinese ? "关闭" : "Close"}</Text>
    </Pressable> : null}
  </View> : null;

  if (failed || !html) return statusBanner;

  return <View style={{ flex: 1, minHeight: 0, backgroundColor: props.theme.colors.surface0 }}>
    {statusBanner}
    {createElement(RNCWebView, {
      ref, source, newSource: source, style: { flex: 1, backgroundColor: props.theme.colors.surface0 },
      javaScriptEnabled: true, messagingEnabled: true, messagingModuleName: "",
      onMessage: receive, onLoadingFinish: (event: { nativeEvent: { title?: string } }) => {
        if (event.nativeEvent.title?.startsWith("Paseo Context error:")) {
          setError(event.nativeEvent.title); report(event.nativeEvent.title.slice(0, 150));
        }
        report("document loaded"); initialize();
      },
      // Android routes WebView.postMessage through a host-owned JS emitter which
      // plugins cannot subscribe to. Local same-origin history events use the
      // native view's direct event channel and never load a network URL.
      onLoadingStart: (event: { nativeEvent: { url: string } }) => {
        const url = event.nativeEvent.url;
        if (!isNativeLoadEventUrl(url, baseUrl, Platform.OS === "android")) {
          const tag = findNodeHandle(ref.current);
          if (tag !== null) UIManager.dispatchViewManagerCommand(tag, "stopLoading", []);
          setError("Navigation outside the bundled interface was blocked.");
          const scheme = /^[a-z]+(?=:)/i.exec(url)?.[0] ?? "unknown";
          report(`unexpected navigation blocked (${scheme})`); return;
        }
        const singleMarker = "#paseo-context=";
        const chunkMarker = "#paseo-context-chunk=";
        const singleAt = url.indexOf(singleMarker);
        const chunkAt = singleAt < 0 ? url.indexOf(chunkMarker) : -1;
        if (singleAt < 0 && chunkAt < 0) { report("navigation started"); return; }
        report("history bridge ready");
        const raw = singleAt >= 0 ? url.slice(singleAt + singleMarker.length) : url.slice(chunkAt + chunkMarker.length);
        const leadingColon = raw.indexOf(":");
        const ackSeq = leadingColon >= 1 ? raw.slice(0, leadingColon) : undefined;
        try {
          if (singleAt >= 0) {
            if (leadingColon >= 1) {
              const message = decodeURIComponent(raw.slice(leadingColon + 1));
              receiveHistory(message);
            }
          } else {
            handleChunkFrame(raw);
          }
        } catch {
          // Malformed or truncated hash payloads must still release the bridge queue.
        } finally {
          inject(ackSeq !== undefined
            ? `globalThis.__PASEO_CONTEXT_ACK__?.(${JSON.stringify(ackSeq)});true;`
            : "globalThis.__PASEO_CONTEXT_ACK__?.();true;");
        }
      },
      onLoadingError: (event: { nativeEvent: { description?: string } }) => setError(event.nativeEvent.description ?? "Could not load the UI"),
      onShouldStartLoadWithRequest: (event: { nativeEvent: { url: string; lockIdentifier: number } }) => {
        const { url, lockIdentifier } = event.nativeEvent;
        TurboModuleRegistry.get<WebViewModule>("RNCWebViewModule")?.shouldStartLoadWithLockIdentifier(isNativeDocumentUrl(url, baseUrl), lockIdentifier);
      },
      cacheEnabled: false, incognito: true, domStorageEnabled: false,
      thirdPartyCookiesEnabled: false, setSupportMultipleWindows: false,
      javaScriptCanOpenWindowsAutomatically: false,
      automaticallyAdjustContentInsets: false, contentInsetAdjustmentBehavior: "never", nestedScrollEnabled: !!props.preview,
    })}
  </View>;
}
