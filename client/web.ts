import { createElement, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useRpc, useSettings, useTranslation } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import { bridgeRpc, settingsPreviewRpc } from "../shared/bridge";
import { preferences } from "../shared/contracts";
import {
  buildInitPayload, createSettingsSaver, handleBridgeAction, handleBridgeRpc,
  platformNameOf, uiDocumentQueryOptions, uiDocumentVariantOf,
} from "./bridge-shared";
import type { FrameProps } from "./frame";
import { messages } from "./messages";

type FrameWindow = { postMessage(message: unknown, target: string): void };
type Frame = { contentWindow: FrameWindow | null };
type Message = { source: unknown; data: any };
interface IntersectionObserverEntryLike {
  isIntersecting: boolean;
  boundingClientRect?: { width: number; height: number };
}
interface IntersectionObserverLike {
  observe(target: unknown): void;
  disconnect(): void;
}
declare const window: {
  addEventListener(type: "message", listener: (event: Message) => void): void;
  removeEventListener(type: "message", listener: (event: Message) => void): void;
};
declare const navigator: { platform?: string; userAgent?: string } | undefined;
declare const IntersectionObserver: (new (
  callback: (entries: IntersectionObserverEntryLike[]) => void,
) => IntersectionObserverLike) | undefined;
interface BrowserBlob {}
declare const Blob: { new(parts: string[], options?: { type: string }): BrowserBlob };
declare const URL: { createObjectURL(blob: BrowserBlob): string; revokeObjectURL(url: string): void };

const IDLE_UNMOUNT_MS = 60_000;
const Iframe = "iframe" as unknown as ComponentType<any>;
const Container = "div" as unknown as ComponentType<any>;

export function WebFrame(props: FrameProps) {
  return Platform.OS === "web" ? createElement(WebFrameHost, props) : null;
}

function WebFrameHost(props: FrameProps) {
  const [attempt, setAttempt] = useState(0);
  return createElement(WebFrameBody, { ...props, key: attempt, retry: () => setAttempt((value) => value + 1) });
}

function WebFrameBody(props: FrameProps & { retry: () => void }) {
  const rpc = useRpc(bridgeRpc);
  const previewRpc = useRpc(settingsPreviewRpc);
  const settings = useSettings(preferences);
  const { locale } = useTranslation(messages);
  const container = useRef<unknown>(null);
  const frame = useRef<Frame | null>(null);
  const docGen = useRef(0);
  const readyNonce = useRef("");
  const latest = useRef({ props, settings, locale, rpc, previewRpc });
  latest.current = { props, settings, locale, rpc, previewRpc };
  const saveSetting = useMemo(() => createSettingsSaver(() => latest.current.settings as any), []);
  const platform = useMemo(() => platformNameOf("web", typeof navigator !== "undefined" ? `${navigator?.platform ?? ""} ${navigator?.userAgent ?? ""}` : ""), []);
  const canObserve = !props.overlay && !props.preview && typeof IntersectionObserver === "function";
  const [visible, setVisible] = useState(() => !canObserve);
  const [active, setActive] = useState(() => !canObserve);
  const [source, setSource] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [slow, setSlow] = useState(false);
  const markupQuery = useQuery({
    ...uiDocumentQueryOptions(rpc, { variant: uiDocumentVariantOf(props.mode), locale }),
    enabled: active,
  });
  const nonce = useMemo(() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`, [markupQuery.data]);
  const chinese = locale.startsWith("zh");
  const docError = markupQuery.error ? (markupQuery.error instanceof Error ? markupQuery.error.message : String(markupQuery.error)) : "";
  const loaded = active && ready && Boolean(source) && (!!props.preview || settings.status === "ready");
  const settingsError = !props.preview && (settings.status === "error" || settings.status === "invalid")
    ? (settings.error || (chinese ? "无法读取设置" : "Preferences unavailable")) : "";
  const failure = error || docError || settingsError;
  const failed = Boolean(failure);

  useEffect(() => {
    if (!canObserve) {
      setVisible(true);
      setActive(true);
      return;
    }
    const node = container.current;
    if (!node || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const rect = entry.boundingClientRect;
      const shown = entry.isIntersecting && (!rect || (rect.width > 0 && rect.height > 0));
      setVisible(shown);
      if (shown) setActive(true);
    });
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, [canObserve]);

  useEffect(() => {
    if (!canObserve || visible || !active) return;
    const timer = setTimeout(() => {
      setActive(false);
      setReady(false);
      setSlow(false);
    }, IDLE_UNMOUNT_MS);
    return () => clearTimeout(timer);
  }, [canObserve, visible, active]);

  useEffect(() => {
    docGen.current++;
    readyNonce.current = "";
    setSlow(false);
    if (!active || failed || !markupQuery.data) {
      setSource("");
      setReady(false);
      return;
    }
    // Give the bundled page its own document URL, as Paseo does for document previews.
    setReady(false);
    const url = URL.createObjectURL(new Blob([markupQuery.data.replaceAll("%%PASEO_CONTEXT_NONCE%%", nonce)], { type: "text/html;charset=utf-8" }));
    setSource(url);
    return () => { URL.revokeObjectURL(url); };
  }, [active, markupQuery.data, nonce, failed]);

  const initialize = () => {
    const { props, settings, locale } = latest.current;
    const values = props.preview?.values ?? (settings.status === "ready" ? settings.values : null);
    if (!values) return;
    frame.current?.contentWindow?.postMessage(buildInitPayload(props, values, nonce, locale, platform), "*");
  };

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const listener = (event: Message) => {
      const { props, rpc, previewRpc } = latest.current;
      const sender = frame.current?.contentWindow;
      if (!alive || !sender || event.source !== sender || event.data?.nonce !== nonce) return;
      const data = event.data;
      if (data.type === "paseo-context:fatal") { setError(String(data.message)); return; }
      if (data.type === "paseo-context:error") {
        if (!props.preview) void rpc({ route: "ui.error", payload: { message: String(data.message ?? "") } }).catch(() => {});
        return;
      }
      if (data.type === "paseo-context:ready") { readyNonce.current = nonce; setSlow(false); setReady(true); initialize(); return; }
      if (data.type === "paseo-context:action") {
        handleBridgeAction(data, props, (url) => { void Linking.openURL(url); });
        return;
      }
      if (data.type !== "paseo-context:rpc") return;
      const gen = docGen.current;
      const reply = (value: unknown, err?: string) => {
        if (alive && docGen.current === gen && frame.current?.contentWindow === sender) sender.postMessage({ type: "paseo-context:result", nonce, id: data.id, value, error: err }, "*");
      };
      void (async () => {
        try {
          if (!alive) return;
          const value = await handleBridgeRpc(data, { props, rpc, previewRpc, saveSetting, copyText });
          if (!alive) return;
          reply(value);
        } catch (err) { reply(null, err instanceof Error ? err.message : String(err)); }
      })();
    };
    window.addEventListener("message", listener);
    return () => { alive = false; window.removeEventListener("message", listener); };
  }, [active, nonce, saveSetting]);

  useEffect(() => {
    if (active && readyNonce.current === nonce) initialize();
  }, [
    active,
    nonce,
    settings.status,
    settings.status === "ready" ? settings.revision : "",
    props.preview?.values,
    locale,
    props.mode,
    props.agentId,
    props.theme.colors.surface0,
  ]);

  useEffect(() => {
    if (!active || loaded || failed) return;
    const timer = setTimeout(() => setSlow(true), 15000);
    return () => clearTimeout(timer);
  }, [active, loaded, failed]);

  const accent = props.theme.colors.accent ?? props.theme.colors.foreground;
  return createElement(Container, {
    ref: container,
    style: props.overlay
      ? { position: "fixed", inset: 0, zIndex: 2147483000, display: "flex", flexDirection: "column" }
      : { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  },
  active && (!loaded || failed) ? createElement(View, { style: { padding: 24, gap: 10, backgroundColor: props.theme.colors.surface0 } },
    createElement(Text, { accessibilityRole: failed ? "alert" : undefined, style: { color: props.theme.colors.foreground } },
      failed ? `Paseo Context · ${failure}` : slow ? chinese ? "界面加载较慢…" : "The interface is taking longer than usual…" : chinese ? "正在打开界面…" : "Opening interface…"),
    failed || slow ? createElement(Pressable, { onPress: () => {
      if (markupQuery.error) void markupQuery.refetch().catch(() => {});
      if (settings.status !== "ready") void settings.reload().catch(() => {});
      props.retry();
    }, accessibilityRole: "button" },
      createElement(Text, { style: { color: accent } }, chinese ? "重新加载" : "Reload")) : null,
    props.onClose ? createElement(Pressable, { onPress: props.onClose, accessibilityRole: "button" },
      createElement(Text, { style: { color: accent } }, chinese ? "关闭" : "Close")) : null) : null,
  active && source && !failed ? createElement(Iframe, {
    ref: frame, title: "Paseo Context", src: source, onLoad: initialize,
    sandbox: props.preview ? "allow-scripts" : "allow-scripts allow-downloads", referrerPolicy: "no-referrer", allow: props.preview ? undefined : "clipboard-write",
    style: { display: "block", width: "100%", height: "100%", minHeight: 0, border: 0, flex: 1, visibility: loaded || slow ? "visible" : "hidden" },
  }) : null);
}
