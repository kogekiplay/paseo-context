import { createRoot } from "react-dom/client";
import { useSyncExternalStore } from "react";
import { makeContextView } from "../src/client/components/contextView";
import { makeFleetView } from "../src/client/components/fleetView";
import { makeOverviewPanel } from "../src/client/components/overviewPanel";
import { makePluginConfigCard } from "../src/client/components/settingsCard";
import { makeContextModal } from "../src/client/components/contextModal";
import { makeViewKit } from "../src/client/viewkit";
import { makeAgentHeads } from "../src/client/agentHeads";
import { createContextSettings } from "../src/client/settings";
import { watchHistoryFaces } from "../src/client/historyPage";
import { DICTS } from "../src/client/i18n";
import { disposeRetention } from "../src/client/retention";
import { modalStoreOf } from "../src/client/modalStore";
import { makeRichText } from "../src/client/components/richText";
import { parseFileAddress } from "./vendor/workspace-path/index.js";
import type { ClientCtx } from "../src/client/services";
import { action, call, send } from "./bridge";
import { makeStatisticsView } from "./statistics";
import { reportedUsageOf } from "../shared/usage";
import { hostMessage } from "./host-messages";
import { PageLoader } from "./page-loader";
import { fullMaxBytes, ImageUrlPool } from "./image-urls";
import "../web/vendor/theme/theme.css";
import "../.tmp/web/tailwind.css";
import "../src/client/styles/base.css";
import "../src/client/styles/stats.css";
import "../src/client/styles/jump.css";
import "../src/client/styles/settings.css";
import "../src/client/styles/stackedBar.css";
import "../src/client/styles/trendChart.css";
import "../src/client/styles/requestDetail.css";
import "../src/client/styles/events.css";
import "../src/client/styles/fileCard.css";
import "../src/client/styles/commandPanel.css";
import "../src/client/styles/modal.css";
import "../src/client/styles/browser.css";
import "../src/client/styles/detailSections.css";
import "../src/client/styles/attachments.css";
import "../src/client/styles/agentGraph.css";
import "../src/client/styles/fleet.css";
import "../src/client/styles/pulse.css";
import "../src/client/styles/overview.css";
import "../src/client/styles/dateRange.css";
import "../src/client/styles/recom.css";
import "./shell.css";
import "./mobile.css";

Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
  writeText: (text: string) => call("clipboard.write", { text }).then(() => undefined),
} });
document.addEventListener("click", (event) => {
  const anchor = (event.target as Element | null)?.closest("a[href]");
  const url = anchor?.getAttribute("href") ?? "";
  if (/^https?:\/\//.test(url)) { event.preventDefault(); action("openExternal", { url }); }
});

type State = {
  initialized: boolean;
  byId: Record<string, any>;
  selected: any;
  familyRevision?: string;
  current: string;
  locale: string;
  mode: string;
  preview?: boolean;
  dark?: boolean;
  platform?: string;
  preferences: Record<string, unknown>;
  image: { src: string; name: string; text?: string; note?: string } | null;
};

const CONTEXT_PREVIEW_KEYS = [
  "defaultGranularity", "defaultTrendMode", "defaultDurationCurve",
  "overviewAutoSteps", "defaultDeltaBase", "defaultToolSort", "defaultFileSort",
] as const;

export function compactDigest(text: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c + i) & 0xffff), 0x85ebca6b) >>> 0;
  }
  return `${text.length.toString(36)}:${h1.toString(16)}:${h2.toString(16)}`;
}

function shallowEqualRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a), keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) if (a[key] !== b[key]) return false;
  return true;
}

function previewKeyFor(mode: string, preferences: Record<string, unknown>, preview?: boolean): string | undefined {
  if (!preview) return undefined;
  if (mode === "insights") return String(preferences.defaultOverviewRange ?? "");
  return JSON.stringify(CONTEXT_PREVIEW_KEYS.map((key) => preferences[key]));
}

let state: State = { initialized: false, byId: {}, selected: null, current: "", locale: "en", mode: "context", preferences: {}, image: null };
const imagePool = new ImageUrlPool();
let lightboxGen = 0;
const listeners = new Set<() => void>(), cleanups: Array<() => void> = [];
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = (next: Partial<State>) => {
  if ("image" in next) {
    if (!next.image) lightboxGen++;
    imagePool.setLightboxUrl(next.image?.src ?? null);
  }
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};
const t = (key: string, params: Record<string, string | number> = {}) => {
  const dict = DICTS[state.locale.split("-")[0] as keyof typeof DICTS] ?? DICTS.en;
  let value = hostMessage(state.locale, key) ?? (dict as Record<string, string>)[key] ?? (DICTS.en as Record<string, string>)[key] ?? key;
  for (const [name, content] of Object.entries(params)) value = value.replaceAll(`{${name}}`, String(content));
  return value;
};
const locale = { bind: () => t, register: () => () => {}, getLocale: () => ({ active: state.locale.split("-")[0] }), subscribe };
let familyRead: AbortController | null = null;
const sessions = {
  list: { getSnapshot: () => state, subscribe },
  getSnapshot: () => state, subscribe, refresh: async () => loader.refresh(),
  scope: () => ({ bail: (_subject: unknown, _event: string, payload: any) => {
    if (!payload?.view) return;
    const mode = payload.view === "context-fleet" ? "fleet" : "context";
    if (state.preview) { action("previewPage", { mode }); return; }
    familyRead?.abort(); familyRead = null; familyStamp = "";
    publish({ mode, selected: null, familyRevision: undefined });
    loader.configure({ agentId: state.current, mode });
  } }),
  refreshSubagents: async (sessionId: string) => {
    if (familyRead || document.hidden) return;
    const controller = new AbortController(), mode = state.mode;
    familyRead = controller;
    try {
      const family = await call("family", { agentId: sessionId, tasks: mode === "fleet" }, { signal: controller.signal });
      if (controller.signal.aborted || sessionId !== state.current || mode !== state.mode || stopped) return;
      const stamp = compactDigest(JSON.stringify(family));
      if (stamp === familyStamp) return;
      familyStamp = stamp;
      publish({ byId: { ...state.byId, ...Object.fromEntries(family.map((row: any) => [row.id, row])) } });
    } catch {}
    finally { if (familyRead === controller) familyRead = null; }
  },
};
let familyStamp = "";
const loadThumbImage = (sessionId: string, attachment: { attachmentId: string }) =>
  imagePool.resolveThumb(
    `${sessionId}\0${attachment.attachmentId}`,
    (maxBytes) => call("api/paseo-context/image", { sessionId, attachmentId: attachment.attachmentId, variant: "thumb", maxBytes }),
  );
const scope = {
  getSnapshot: () => ({ status: state.initialized ? "ready" : "loading", value: state.preferences, writable: !state.preview }),
  subscribe,
  set: async (field: string, value: unknown) => {
    if (state.preview) return;
    const values = await call("settings.set", { field, value });
    publish({ preferences: values });
  },
};
const context = {
  locale, slots: { entries: () => [], inject: (_name: string, fn: () => unknown) => fn(), register: () => () => {} },
  remote: { session: { page: (request: unknown, signal?: AbortSignal) => call("history.page", request, { signal }) } },
  get(name: string) {
    return ({ sessions, locale, paseoContextPreview: state.preview, connection: { isLoopback: false },
      uiWorkspace: { openSession: (id: string) => action("openAgent", { agentId: id }) },
      uiConversation: {
        imageUrl: loadThumbImage,
        openImage: async (sessionId: string, attachment: { attachmentId: string; name?: string }) => {
          const gen = ++lightboxGen;
          const raw = await call("api/paseo-context/image", {
            sessionId, attachmentId: attachment.attachmentId, variant: "full", maxBytes: fullMaxBytes(),
          });
          if (gen !== lightboxGen || stopped || sessionId !== state.current) return false;
          const src = typeof raw === "string" ? imagePool.toLightboxUrl(raw) : "";
          publish({ image: { src, name: attachment.name || "Image" } }); return true;
        },
      },
      configForms: { get: () => scope }, settings: { open: () => action("openSettings") },
      pluginNavigation: { openBundle: () => action("openSettings") },
      sidebarRight: { openResource: (address: string) => {
        if (address.startsWith("paseo-resource://subagentchat/session/")) {
          const id = decodeURIComponent(new URL(address).pathname.split("/").at(-1)!);
          action("openAgent", { agentId: id }); return;
        }
        const file = parseFileAddress(address);
        if (!file) throw new Error("Unsupported resource");
        const agentId = file.scope === "session" ? file.sessionId : state.current;
        const gen = ++lightboxGen;
        void call("api/paseo-context/file.preview", { agentId, path: file.path, maxBytes: fullMaxBytes() })
          .then((preview) => {
            if (gen !== lightboxGen || stopped) return;
            const src = typeof preview?.src === "string" ? imagePool.toLightboxUrl(preview.src) : "";
            publish({ image: preview ? { ...preview, src } : null });
          })
          .catch((error: unknown) => {
            if (gen !== lightboxGen || stopped) return;
            publish({ image: { src: "", name: file.path, text: String(error) } });
          });
      } },
    } as Record<string, unknown>)[name];
  },
  inject(_names: readonly string[], fn: (ctx: unknown) => unknown) {
    const cleanup = fn(context); if (typeof cleanup === "function") cleanups.push(cleanup as () => void); return cleanup;
  },
  effect(fn: () => unknown) { const cleanup = fn(); if (typeof cleanup === "function") cleanups.push(cleanup as () => void); return cleanup; },
} as unknown as ClientCtx;
const settings = createContextSettings();
settings.attach(scope);
watchHistoryFaces(context);
const kit = makeViewKit(t, locale), heads = makeAgentHeads();
const Rich = makeRichText(kit);
const ContextView = makeContextView(context, kit, settings, heads);
const FleetView = makeFleetView(context, kit, heads);
const Overview = makeOverviewPanel(context, kit, settings);
const Config = makePluginConfigCard(kit);
const ContextModal = makeContextModal(context, kit, settings);
const Statistics = makeStatisticsView(kit);
// App subscribes once to the projection snapshot. The upstream host supplies a
// read function here; several consumers read optional projections conditionally.
const useProjection = (key: string) => {
  if (key === "contextTimeline") return state.selected?.head ?? null;
  if (key === "contextHeaders") return state.selected?.headers ?? null;
  return state.byId[state.current]?.projectionValues?.[key] ?? null;
};
const useSessions = <T,>(selector: (snapshot: any) => T) => selector(state);
function App() {
  const s = useSyncExternalStore(subscribe, () => state);
  const loadingLabel = s.locale.startsWith("zh") ? "正在加载…" : "Loading…";
  if (!s.initialized) return <div className="pc-status" role="status">{loadingLabel}</div>;
  const previewKey = previewKeyFor(s.mode, s.preferences, s.preview);
  if (s.mode === "insights") return <Overview key={previewKey} useSessions={useSessions} />;
  if (s.mode === "settings") return <div className="pc-settings"><Config useContextSettings={(selector) => useSyncExternalStore(settings.store.subscribe, () => selector(settings.store.getSnapshot()))} set={(field, value) => settings.set(field, value)} /></div>;
  if (!s.current) return <div className="pc-status">{t("trend.empty")}</div>;
  if (!s.selected) return <div className="pc-status" role="status">{loadingLabel}</div>;
  const props = { sessionId: s.current, useProjection };
  if (s.mode === "statistics") return <Statistics key={s.current} {...props} locale={s.locale} snapshot={s.selected?.statistics ?? null} loadImage={(attachment) => loadThumbImage(s.current, attachment)} />;
  if (s.mode === "modal") return <ContextModal {...props} useContextModal={(selector) => useSyncExternalStore(modalStoreOf(s.current).subscribe, () => selector(modalStoreOf(s.current).getSnapshot()))} />;
  return s.mode === "fleet" ? <FleetView {...props} /> : <ContextView key={previewKey === undefined ? undefined : `${s.current}:${previewKey}`}
    host={s.mode === "sidebar-context" ? "sidebar" : undefined} {...props} />;
}
function ImagePreview() {
  const image = useSyncExternalStore(subscribe, () => state.image);
  const rich = Rich.useRichView(image?.text ?? "");
  if (!image) return null;
  return <div className="lc-modal-backdrop" onClick={() => publish({ image: null })}>
    <div className="lc-modal-card" onClick={(event) => event.stopPropagation()} style={{ maxWidth: "95vw", maxHeight: "95vh" }}>
      <div className="lc-modal-head"><span className="lc-modal-title">{image.name}</span>
        {image.text !== undefined && rich.tools}<button className="lc-modal-close" aria-label={t("cmd.close")} onClick={() => publish({ image: null })}>×</button></div>
      {image.note && <div className="lc-detail-note">{image.note}</div>}
      {image.text !== undefined ? <div className="lc-modal-body" style={{ overflow: "auto" }}>{rich.body}</div>
        : <img src={image.src} alt={image.name} style={{ maxWidth: "100%", maxHeight: "85vh", objectFit: "contain" }} />}
    </div>
  </div>;
}
let stopped = false, rendered = false;
const loader = new PageLoader({
  read: ({ agentId, mode }, signal) => call("bootstrap", {
    agentId, mode: mode === "sidebar-context" ? "context" : mode, revision: state.selected?.revision, familyRevision: state.familyRevision,
  }, { signal }),
  accept: (_target, result) => {
    const selected = result.selected?.unchanged ? state.selected : result.selected;
    // No state publication means no chart/table reconstruction for an idle session.
    if (selected !== state.selected || result.familyRevision !== state.familyRevision) {
      const familyChanged = result.familyRevision !== undefined && result.familyRevision !== state.familyRevision;
      const incoming = Object.fromEntries(result.sessions.map((row: any) => [row.id, {
        ...row, projectionValues: { ...state.byId[row.id]?.projectionValues, ...row.projectionValues },
      }]));
      const byId = familyChanged ? incoming : { ...state.byId, ...incoming };
      if (selected?.head && state.current) {
        const head = selected.head;
        byId[state.current] = { ...byId[state.current], projectionValues: {
          ...byId[state.current]?.projectionValues,
          contextTimeline: head, contextHeaders: selected.headers,
          contextPressure: { pressureTokens: head.last?.prompt, contextWindow: head.contextWindow },
          tokenUsage: reportedUsageOf(head),
        } };
      }
      publish({ byId, selected, familyRevision: result.familyRevision });
    }
    if (!rendered) {
      rendered = true;
      send({ type: "paseo-context:status", nonce: (globalThis as any).__PASEO_CONTEXT_NONCE__, phase: "rendered" });
    }
    const error = document.getElementById("pc-error");
    if (error) error.textContent = "";
    const wantsFamily = () => state.mode === "context" || state.mode === "sidebar-context" || state.mode === "modal";
    if (wantsFamily()) {
      // Headline and browser paint first; family costs follow independently.
      requestAnimationFrame(() => {
        if (!stopped && wantsFamily()) void sessions.refreshSubagents(state.current);
      });
    }
  },
  error: (error) => {
    const root = document.getElementById("pc-error");
    if (root) root.textContent = error instanceof Error ? error.message : String(error);
  },
});
let modalSession: string | null = null, modalOff: (() => void) | null = null;
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.type !== "paseo-context:init" || event.data?.nonce !== (globalThis as any).__PASEO_CONTEXT_NONCE__) return;
  const current = event.data.agentId || "";
  const mode = event.data.mode || "context";
  const nextLocale = event.data.locale || "en";
  const preview = event.data.preview === true;
  const dark = event.data.dark === true;
  const platform = typeof event.data.platform === "string" && event.data.platform ? event.data.platform : "";
  const preferences: Record<string, unknown> = event.data.preferences && typeof event.data.preferences === "object" ? event.data.preferences : {};

  if (
    state.initialized
    && current === state.current
    && mode === state.mode
    && nextLocale === state.locale
    && preview === !!state.preview
    && dark === !!state.dark
    && platform === (state.platform ?? "")
    && shallowEqualRecord(preferences, state.preferences)
  ) {
    return;
  }

  const targetChanged = !state.initialized || current !== state.current || mode !== state.mode;
  if (targetChanged) {
    familyRead?.abort(); familyRead = null; familyStamp = "";
    lightboxGen++;
    imagePool.clearThumbs();
  }
  document.body.toggleAttribute("data-pc-preview", preview);
  if (platform) document.documentElement.dataset.platform = platform;
  else delete document.documentElement.dataset.platform;
  if (dark) document.body.setAttribute("data-ds-dark-theme", ""); else document.body.removeAttribute("data-ds-dark-theme");
  publish({
    initialized: true,
    current,
    ...(targetChanged ? { selected: null, image: null, byId: {}, familyRevision: undefined } : {}),
    locale: nextLocale,
    mode,
    preview,
    dark,
    platform,
    preferences,
  });
  const modalTarget = state.mode === "modal" ? state.current : null;
  if (modalTarget !== modalSession) {
    modalOff?.(); modalOff = null;
    if (modalSession) modalStoreOf(modalSession).set(false);
    modalSession = modalTarget;
  }
  if (state.mode === "modal" && !modalOff) {
    const store = modalStoreOf(state.current);
    store.set(true);
    modalOff = store.subscribe(() => { if (!store.getSnapshot()) action("close"); });
    document.body.style.background = "transparent";
  }
  if (state.mode !== "modal") document.body.style.background = "";
  loader.configure({ agentId: current, mode, preview });
  if ((mode === "settings" || mode === "insights") && !rendered) {
    rendered = true;
    send({ type: "paseo-context:status", nonce: (globalThis as any).__PASEO_CONTEXT_NONCE__, phase: "rendered" });
  }
});
loader.visibility(!document.hidden);
document.addEventListener("visibilitychange", () => {
  loader.visibility(!document.hidden);
  if (document.hidden) { familyRead?.abort(); familyRead = null; }
});
window.addEventListener("pagehide", () => {
  stopped = true; loader.dispose();
  familyRead?.abort(); familyRead = null; familyStamp = "";
  lightboxGen++;
  imagePool.dispose();
  modalOff?.(); modalOff = null;
  if (modalSession) modalStoreOf(modalSession).set(false);
  for (const cleanup of cleanups.splice(0)) cleanup();
  disposeRetention(); listeners.clear();
});
createRoot(document.getElementById("root")!).render(<><App /><ImagePreview /><div id="pc-error" role="status" /></>);
(globalThis as any).__PASEO_CONTEXT_BOOTED__ = true;
send({ type: "paseo-context:ready", nonce: (globalThis as any).__PASEO_CONTEXT_NONCE__ });
