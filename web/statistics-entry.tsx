import { createRoot } from "react-dom/client";
import { useSyncExternalStore } from "react";
import type { ViewKit } from "../src/client/viewkit";
import { action, call, send } from "./bridge";
import { makeStatisticsView } from "./statistics";
import { PageLoader } from "./page-loader";
import { ImageUrlPool } from "./image-urls";
import "../web/vendor/theme/theme.css";
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
  selected: any;
  familyRevision?: string;
  current: string;
  locale: string;
  preview?: boolean;
  dark?: boolean;
  platform?: string;
};

let state: State = { initialized: false, selected: null, current: "", locale: "en" };
const imagePool = new ImageUrlPool();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

const loadThumbImage = (sessionId: string, attachment: { attachmentId: string }) =>
  imagePool.resolveThumb(
    `${sessionId}\0${attachment.attachmentId}`,
    (maxBytes) => call("api/paseo-context/image", { sessionId, attachmentId: attachment.attachmentId, variant: "thumb", maxBytes }),
  );

const Statistics = makeStatisticsView({} as ViewKit);
const useProjection = () => null;

function App() {
  const s = useSyncExternalStore(subscribe, () => state);
  const loadingLabel = s.locale.startsWith("zh") ? "正在加载…" : "Loading…";
  if (!s.initialized) return <div className="pc-status" role="status">{loadingLabel}</div>;
  if (!s.current) return <div className="pc-status">{s.locale.startsWith("zh") ? "暂无记录" : "No requests recorded yet"}</div>;
  if (!s.selected) return <div className="pc-status" role="status">{loadingLabel}</div>;
  return <Statistics
    key={s.current}
    sessionId={s.current}
    useProjection={useProjection}
    locale={s.locale}
    snapshot={s.selected?.statistics ?? null}
    loadImage={(attachment) => loadThumbImage(s.current, attachment)}
  />;
}

let rendered = false, stopped = false;
const loader = new PageLoader({
  read: ({ agentId }, signal) => call("bootstrap", {
    agentId, mode: "statistics", revision: state.selected?.revision, familyRevision: state.familyRevision,
  }, { signal }),
  accept: (_target, result) => {
    if (stopped) return;
    const selected = result.selected?.unchanged ? state.selected : result.selected;
    if (selected !== state.selected || result.familyRevision !== state.familyRevision) {
      publish({ selected, familyRevision: result.familyRevision });
    }
    if (!rendered) {
      rendered = true;
      send({ type: "paseo-context:status", nonce: (globalThis as any).__PASEO_CONTEXT_NONCE__, phase: "rendered" });
    }
    const error = document.getElementById("pc-error");
    if (error) error.textContent = "";
  },
  error: (error) => {
    if (stopped) return;
    const root = document.getElementById("pc-error");
    if (root) root.textContent = error instanceof Error ? error.message : String(error);
  },
});

window.addEventListener("message", (event) => {
  if (stopped || event.source !== parent || event.data?.type !== "paseo-context:init" || event.data?.nonce !== (globalThis as any).__PASEO_CONTEXT_NONCE__) return;
  const current = event.data.agentId || "";
  const nextLocale = event.data.locale || "en";
  const preview = event.data.preview === true;
  const dark = event.data.dark === true;
  const platform = typeof event.data.platform === "string" && event.data.platform ? event.data.platform : "";

  if (
    state.initialized
    && current === state.current
    && nextLocale === state.locale
    && preview === !!state.preview
    && dark === !!state.dark
    && platform === (state.platform ?? "")
  ) {
    return;
  }

  const targetChanged = !state.initialized || current !== state.current;
  if (targetChanged) imagePool.clearThumbs();
  document.body.toggleAttribute("data-pc-preview", preview);
  if (platform) document.documentElement.dataset.platform = platform;
  else delete document.documentElement.dataset.platform;
  if (dark) document.body.setAttribute("data-ds-dark-theme", ""); else document.body.removeAttribute("data-ds-dark-theme");
  document.body.style.background = "";
  publish({
    initialized: true,
    current,
    ...(targetChanged ? { selected: null, familyRevision: undefined } : {}),
    locale: nextLocale,
    preview,
    dark,
    platform,
  });
  loader.configure({ agentId: current, mode: "statistics", preview });
});

loader.visibility(!document.hidden);
document.addEventListener("visibilitychange", () => {
  loader.visibility(!document.hidden);
});
window.addEventListener("pagehide", () => {
  stopped = true;
  loader.dispose();
  imagePool.dispose();
  listeners.clear();
});
createRoot(document.getElementById("root")!).render(<><App /><div id="pc-error" role="status" /></>);
(globalThis as any).__PASEO_CONTEXT_BOOTED__ = true;
send({ type: "paseo-context:ready", nonce: (globalThis as any).__PASEO_CONTEXT_NONCE__ });
