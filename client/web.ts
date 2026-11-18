import { createElement, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useRpc, useSettings, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { bridgeRpc } from "../shared/bridge";
import { preferences } from "../shared/contracts";
import { upstreamHtmlGzip } from "../shared/generated/upstream-ui";
import { messages } from "./messages";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import { copyText } from "@getpaseo/plugin/client/ui";

type FrameWindow = { postMessage(message: unknown, target: string): void };
type Frame = { contentWindow: FrameWindow | null };
type Message = { source: unknown; data: any };
declare const window: {
  addEventListener(type: "message", listener: (event: Message) => void): void;
  removeEventListener(type: "message", listener: (event: Message) => void): void;
};
declare function atob(value: string): string;
interface BrowserBlob { stream(): { pipeThrough(transform: unknown): unknown } }
declare const Blob: { new(parts: (ArrayBuffer | string)[], options?: { type: string }): BrowserBlob };
declare const URL: { createObjectURL(blob: BrowserBlob): string; revokeObjectURL(url: string): void };
declare const DecompressionStream: { new(format: "gzip"): unknown };
declare const Response: { new(body: unknown): { text(): Promise<string> } };
type Props = PluginSurfaceProps & {
  mode: "context" | "fleet" | "statistics" | "insights" | "settings" | "modal";
  agentId?: string; overlay?: boolean; onClose?: () => void;
  openSettings: () => void; openContext: (agentId: string) => void;
};
const originalPreferences = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) =>
  [key, typeof value === "boolean" ? value ? "show" : "hide" : value]));
const Iframe = "iframe" as unknown as ComponentType<any>;
let documentPromise: Promise<string> | undefined;
function readDocument() {
  return documentPromise ??= (async () => {
    const bytes = Uint8Array.from(atob(upstreamHtmlGzip), (c) => c.charCodeAt(0));
    const stream = new Blob([bytes.buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  })().catch((error) => { documentPromise = undefined; throw error; });
}
export function WebFrame(props: Props) {
  return Platform.OS === "web" ? createElement(WebFrameHost, props) : null;
}
function WebFrameHost(props: Props) {
  const [attempt, setAttempt] = useState(0);
  return createElement(WebFrameBody, { ...props, key: attempt, retry: () => setAttempt((value) => value + 1) });
}
function WebFrameBody(props: Props & { retry: () => void }) {
  const rpc = useRpc(bridgeRpc), settings = useSettings(preferences), { locale } = useTranslation(messages);
  const frame = useRef<Frame | null>(null);
  const latest = useRef({ props, settings, locale });
  latest.current = { props, settings, locale };
  const nonce = useMemo(() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`, []);
  const [source, setSource] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [slow, setSlow] = useState(false);
  const chinese = locale.startsWith("zh");
  const loaded = ready && settings.status === "ready";
  const failure = error || (settings.status === "error" || settings.status === "invalid" ? settings.error : "");
  const failed = Boolean(failure);
  useEffect(() => {
    if (failed) {
      setSource("");
      setReady(false);
      return;
    }
    let active = true;
    let url: string | undefined;
    void readDocument().then((value) => {
      if (!active) return;
      // Give the bundled page its own document URL, as Paseo does for document previews.
      url = URL.createObjectURL(new Blob([value.replaceAll("%%PASEO_CONTEXT_NONCE%%", nonce)], { type: "text/html;charset=utf-8" }));
      setSource(url);
    })
      .catch((error: unknown) => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [nonce, failed]);
  const initialize = () => {
    const { props, settings, locale } = latest.current;
    if (settings.status !== "ready") return;
    const hex = props.theme.colors.surface0.replace("#", ""), short = hex.length === 3;
    const rgb = short ? hex.split("").map((c) => parseInt(c + c, 16)) : [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
    frame.current?.contentWindow?.postMessage({ type: "paseo-context:init", nonce, agentId: props.agentId ?? "", mode: props.mode,
      locale, preferences: originalPreferences(settings.values), dark: rgb.reduce((n, c) => n + c, 0) / 3 < 128 }, "*");
  };
  useEffect(() => {
    let active = true;
    const listener = (event: Message) => {
      const { props, settings } = latest.current;
      const sender = frame.current?.contentWindow;
      if (!active || !sender || event.source !== sender || event.data?.nonce !== nonce) return;
      const data = event.data;
      if (data.type === "paseo-context:fatal") { setError(String(data.message)); return; }
      if (data.type === "paseo-context:ready") { setSlow(false); setReady(true); initialize(); return; }
      if (data.type === "paseo-context:action") {
        if (data.name === "openAgent") {
          const id = String(data.payload?.agentId ?? "");
          if (id.startsWith("native:")) props.openContext(id); else props.navigation?.openAgent({ agentId: id });
        } else if (data.name === "openSettings") props.openSettings();
        else if (data.name === "close") props.onClose?.();
        else if (data.name === "openExternal") {
          const url = String(data.payload?.url ?? "");
          if (/^https?:\/\//.test(url)) void Linking.openURL(url);
        }
        return;
      }
      if (data.type !== "paseo-context:rpc") return;
      const reply = (value: unknown, error?: string) => {
        if (active && frame.current?.contentWindow === sender) sender.postMessage({ type: "paseo-context:result", nonce, id: data.id, value, error }, "*");
      };
      void (async () => {
        try {
          if (!active) return;
          if (data.route === "clipboard.write") {
            await copyText(String(data.payload?.text ?? ""));
            if (!active) return;
            reply(true); return;
          }
          if (data.route === "settings.set") {
            if (settings.status !== "ready") throw new Error("Preferences are not ready");
            const key = String(data.payload?.field);
            if (!(key in settings.values)) throw new Error("Unknown preference");
            const value = typeof settings.values[key as keyof typeof settings.values] === "boolean" ? data.payload?.value === "show" : data.payload?.value;
            const next = { ...settings.values, [key]: value };
            if (!active) return;
            if (!await settings.save(next, settings.revision)) throw new Error("Could not save preferences; reload and retry");
            if (!active) return;
            reply(originalPreferences(next)); return;
          }
          const value = await rpc({ route: String(data.route), payload: data.payload });
          if (!active) return;
          reply(value);
        } catch (error) { reply(null, error instanceof Error ? error.message : String(error)); }
      })();
    };
    window.addEventListener("message", listener);
    return () => { active = false; window.removeEventListener("message", listener); };
  }, [rpc, nonce]);
  useEffect(initialize, [settings.status, settings.status === "ready" ? settings.revision : "", locale, props.mode, props.agentId, props.theme.colors.surface0]);
  useEffect(() => {
    if (loaded || failed) return;
    const timer = setTimeout(() => setSlow(true), 15000);
    return () => clearTimeout(timer);
  }, [loaded, failed, chinese]);
  const Container = "div" as unknown as ComponentType<any>;
  return createElement(Container, { style: props.overlay
    ? { position: "fixed", inset: 0, zIndex: 2147483000, display: "flex", flexDirection: "column" }
    : { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } },
    !loaded || failed ? createElement(View, { style: { padding: 24, gap: 10, backgroundColor: props.theme.colors.surface0 } },
      createElement(Text, { accessibilityRole: failed ? "alert" : undefined, style: { color: props.theme.colors.foreground } },
        failed ? `Paseo Context · ${failure}` : slow ? chinese ? "界面加载较慢…" : "The interface is taking longer than usual…" : chinese ? "正在打开界面…" : "Opening interface…"),
      failed || slow ? createElement(Pressable, { onPress: () => {
        if (settings.status !== "ready") void settings.reload().catch(() => {});
        props.retry();
      }, accessibilityRole: "button" },
        createElement(Text, { style: { color: props.theme.colors.accent } }, chinese ? "重新加载" : "Reload")) : null,
      props.onClose ? createElement(Pressable, { onPress: props.onClose, accessibilityRole: "button" },
        createElement(Text, { style: { color: props.theme.colors.accent } }, chinese ? "关闭" : "Close")) : null) : null,
    source && !failed ? createElement(Iframe, {
      ref: frame, title: "Paseo Context", src: source, onLoad: initialize,
      sandbox: "allow-scripts allow-downloads", referrerPolicy: "no-referrer", allow: "clipboard-write",
      style: { display: "block", width: "100%", height: "100%", minHeight: 0, border: 0, flex: 1, visibility: loaded || slow ? "visible" : "hidden" },
    }) : null);
}
