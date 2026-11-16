import { createElement, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useRpc, useSettings, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { bridgeRpc } from "../shared/bridge";
import { preferences } from "../shared/contracts";
import { upstreamHtmlGzip } from "../shared/generated/upstream-ui";
import { messages } from "./messages";
import { Linking, Platform } from "react-native";
import { copyText } from "@getpaseo/plugin/client/ui";

type FrameWindow = { postMessage(message: unknown, target: string): void };
type Frame = { contentWindow: FrameWindow | null };
type Message = { source: unknown; data: any };
declare const window: {
  addEventListener(type: "message", listener: (event: Message) => void): void;
  removeEventListener(type: "message", listener: (event: Message) => void): void;
};
declare function atob(value: string): string;
declare const Blob: { new(parts: ArrayBuffer[]): { stream(): { pipeThrough(transform: unknown): unknown } } };
declare const DecompressionStream: { new(format: "gzip"): unknown };
declare const Response: { new(body: unknown): { text(): Promise<string> } };
type Props = PluginSurfaceProps & {
  mode: "context" | "fleet" | "insights" | "settings" | "modal";
  agentId?: string; overlay?: boolean; onClose?: () => void;
  openSettings: () => void; openContext: (agentId: string) => void;
};
const originalPreferences = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) =>
  [key, typeof value === "boolean" ? value ? "show" : "hide" : value]));
const Iframe = "iframe" as unknown as ComponentType<any>;
export function WebFrame(props: Props) {
  return Platform.OS === "web" ? createElement(WebFrameBody, props) : null;
}
function WebFrameBody(props: Props) {
  const rpc = useRpc(bridgeRpc), settings = useSettings(preferences), { locale } = useTranslation(messages);
  const frame = useRef<Frame | null>(null);
  const latest = useRef({ props, settings, locale });
  latest.current = { props, settings, locale };
  const nonce = useMemo(() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`, []);
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const bytes = Uint8Array.from(atob(upstreamHtmlGzip), (c) => c.charCodeAt(0));
    const stream = new Blob([bytes.buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    void new Response(stream).text().then((value) => { if (active) setHtml(value.replaceAll("%%PASEO_CONTEXT_NONCE%%", nonce)); })
      .catch((error: unknown) => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [nonce]);
  const initialize = () => {
    const { props, settings, locale } = latest.current;
    if (settings.status !== "ready") return;
    const hex = props.theme.colors.surface0.replace("#", ""), short = hex.length === 3;
    const rgb = short ? hex.split("").map((c) => parseInt(c + c, 16)) : [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
    frame.current?.contentWindow?.postMessage({ type: "paseo-context:init", nonce, agentId: props.agentId ?? "", mode: props.mode,
      locale, preferences: originalPreferences(settings.values), dark: rgb.reduce((n, c) => n + c, 0) / 3 < 128 }, "*");
  };
  useEffect(() => {
    const listener = (event: Message) => {
      const { props, settings } = latest.current;
      if (event.source !== frame.current?.contentWindow || event.data?.nonce !== nonce) return;
      const data = event.data;
      if (data.type === "paseo-context:fatal") { setError(String(data.message)); return; }
      if (data.type === "paseo-context:ready") { initialize(); return; }
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
        frame.current?.contentWindow?.postMessage({ type: "paseo-context:result", nonce, id: data.id, value, error }, "*");
      };
      void (async () => {
        try {
          if (data.route === "clipboard.write") {
            await copyText(String(data.payload?.text ?? ""));
            reply(true); return;
          }
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
    window.addEventListener("message", listener);
    return () => { window.removeEventListener("message", listener); };
  }, [rpc, nonce]);
  useEffect(initialize, [settings.status === "ready" ? settings.revision : "", locale, props.mode, props.agentId, props.theme.colors.surface0]);
  if (error) return createElement("div" as unknown as ComponentType<any>, {
    role: "alert", style: { padding: 24, color: props.theme.colors.foreground },
  }, `Paseo Context: ${error}`);
  return createElement(Iframe, {
    ref: frame, title: "Paseo Context", srcDoc: html, onLoad: initialize,
    sandbox: "allow-scripts allow-downloads", allow: "clipboard-write",
    style: props.overlay ? { position: "fixed", inset: 0, width: "100vw", height: "100vh", border: 0, zIndex: 2147483000, background: "transparent" }
      : { display: "block", width: "100%", height: "100%", minHeight: 0, border: 0, flex: 1 },
  });
}
