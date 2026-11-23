export interface ParsedProgress {
  prefix: string;
  covered: number;
  total: number;
  suffix: string;
}

const PROGRESS_RE = /^([\s\S]*?[（(])(\d+)\/(\d+)([)）][\s\S]*)$/;
const INTEGER_RE = /^\d+$/;
const INTERP_DURATION_MS = 200;

export function parseFoldProgress(text: string): ParsedProgress | null {
  const match = PROGRESS_RE.exec(text);
  if (!match) return null;
  const covered = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(covered) || !Number.isSafeInteger(total) || total <= 0 || covered < 0 || covered > total) {
    return null;
  }
  return { prefix: match[1], covered, total, suffix: match[4] };
}

export function interpolateBounded(from: number, to: number, progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  const eased = 1 - (1 - clamped) ** 3;
  const value = Math.round(from + (to - from) * eased);
  return Math.max(from, Math.min(to, value));
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

interface FoldingTrack {
  raf: number;
  displayed: number;
  target: number;
  total: number;
  rawTarget: string;
}

interface KpiTrack {
  raf: number;
  displayed: number;
  target: number;
  rawTarget: string;
}

function setDisplay(el: Element, value: string): void {
  el.setAttribute("data-pc-display", value);
  el.setAttribute("data-pc-animating", "1");
}

function clearDisplay(el: Element): void {
  el.removeAttribute("data-pc-animating");
  el.removeAttribute("data-pc-display");
}

/**
 * Host-side smooth progress and KPI number transitions during Insights backfill.
 * Never mutates React-managed DOM text nodes: animates via data attributes + CSS
 * ::after overlay so DOM textContent always remains the authoritative server value,
 * and strictly bounds interpolation between consecutive real snapshots (`prev -> next <= total`).
 */
export function watchBackfillMotion(root: Node | null): () => void {
  if (!root || typeof MutationObserver !== "function" || typeof requestAnimationFrame !== "function") {
    return () => {};
  }

  const foldingTracks = new WeakMap<Element, FoldingTrack>();
  const kpiTracks = new WeakMap<Element, KpiTrack>();
  const kpiLastText = new WeakMap<Element, string>();
  const activeElements = new Set<Element>();
  const activeRafs = new Set<number>();

  const cancelFrame = (id: number) => {
    if (!id) return;
    activeRafs.delete(id);
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  };

  const stopElement = (el: Element, dropTrack = false) => {
    const fold = foldingTracks.get(el);
    if (fold?.raf) {
      cancelFrame(fold.raf);
      fold.raf = 0;
    }
    const kpi = kpiTracks.get(el);
    if (kpi?.raf) {
      cancelFrame(kpi.raf);
      kpi.raf = 0;
    }
    if (dropTrack) {
      foldingTracks.delete(el);
      kpiTracks.delete(el);
    }
    clearDisplay(el);
    activeElements.delete(el);
  };

  const pruneDisconnected = () => {
    for (const el of [...activeElements]) {
      if (!el.isConnected) stopElement(el, true);
    }
  };

  const bumpClass = (el: Element) => {
    if (!el.classList) return;
    el.classList.remove("pc-kpi-bump");
    const id = requestAnimationFrame(() => {
      activeRafs.delete(id);
      if (el.isConnected) el.classList.add("pc-kpi-bump");
    });
    activeRafs.add(id);
  };

  const handleFolding = (el: Element) => {
    const raw = el.textContent ?? "";
    const parsed = parseFoldProgress(raw);
    const prev = foldingTracks.get(el);
    if (!parsed) {
      stopElement(el, true);
      return;
    }
    if (prefersReducedMotion() || !prev || prev.total !== parsed.total || parsed.covered < prev.displayed) {
      stopElement(el, false);
      foldingTracks.set(el, {
        raf: 0,
        displayed: parsed.covered,
        target: parsed.covered,
        total: parsed.total,
        rawTarget: raw,
      });
      return;
    }
    if (parsed.covered === prev.displayed && prev.raf === 0) {
      clearDisplay(el);
      activeElements.delete(el);
      return;
    }
    if (prev.target === parsed.covered && prev.rawTarget === raw) return;
    if (prev.raf) cancelFrame(prev.raf);
    const from = prev.displayed;
    const to = Math.min(parsed.covered, parsed.total);
    const started = typeof performance !== "undefined" ? performance.now() : Date.now();
    const track: FoldingTrack = { raf: 0, displayed: from, target: to, total: parsed.total, rawTarget: raw };
    foldingTracks.set(el, track);
    activeElements.add(el);

    const step = (now: number) => {
      activeRafs.delete(track.raf);
      track.raf = 0;
      if (!el.isConnected) {
        stopElement(el, true);
        return;
      }
      const elapsed = Math.max(0, (typeof performance !== "undefined" ? now : Date.now()) - started);
      const t = elapsed / INTERP_DURATION_MS;
      if (t >= 1) {
        track.displayed = to;
        clearDisplay(el);
        activeElements.delete(el);
        return;
      }
      const nextValue = interpolateBounded(from, to, t);
      if (nextValue !== track.displayed) {
        track.displayed = nextValue;
        setDisplay(el, `${parsed.prefix}${nextValue}/${parsed.total}${parsed.suffix}`);
      }
      track.raf = requestAnimationFrame(step);
      activeRafs.add(track.raf);
    };
    setDisplay(el, `${parsed.prefix}${from}/${parsed.total}${parsed.suffix}`);
    track.raf = requestAnimationFrame(step);
    activeRafs.add(track.raf);
  };

  const handleKpi = (el: Element, backfilling: boolean) => {
    const raw = (el.textContent ?? "").trim();
    const prevText = kpiLastText.get(el);
    kpiLastText.set(el, raw);
    if (!backfilling || prefersReducedMotion()) {
      stopElement(el, true);
      return;
    }
    if (prevText === undefined || prevText === raw) return;
    const existing = kpiTracks.get(el);
    if (INTEGER_RE.test(prevText) && INTEGER_RE.test(raw)) {
      const from = existing ? existing.displayed : Number(prevText);
      const to = Number(raw);
      if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && to > from) {
        if (existing?.raf) cancelFrame(existing.raf);
        const started = typeof performance !== "undefined" ? performance.now() : Date.now();
        const track: KpiTrack = { raf: 0, displayed: from, target: to, rawTarget: raw };
        kpiTracks.set(el, track);
        activeElements.add(el);
        const step = (now: number) => {
          activeRafs.delete(track.raf);
          track.raf = 0;
          if (!el.isConnected) {
            stopElement(el, true);
            return;
          }
          const elapsed = Math.max(0, (typeof performance !== "undefined" ? now : Date.now()) - started);
          const t = elapsed / INTERP_DURATION_MS;
          if (t >= 1) {
            track.displayed = to;
            clearDisplay(el);
            activeElements.delete(el);
            return;
          }
          const nextValue = interpolateBounded(from, to, t);
          if (nextValue !== track.displayed) {
            track.displayed = nextValue;
            setDisplay(el, String(nextValue));
          }
          track.raf = requestAnimationFrame(step);
          activeRafs.add(track.raf);
        };
        setDisplay(el, String(from));
        track.raf = requestAnimationFrame(step);
        activeRafs.add(track.raf);
        return;
      }
      stopElement(el, true);
      return;
    }
    stopElement(el, true);
    bumpClass(el);
  };

  const scan = () => {
    pruneDisconnected();
    const container = root as ParentNode;
    if (typeof container.querySelectorAll !== "function") return;
    const pills = container.querySelectorAll(".lc-ov-folding:not(.lc-ov-folding-action)");
    const backfilling = pills.length > 0;
    for (const pill of pills) handleFolding(pill);
    const kpis = container.querySelectorAll(".lc-ov-kpi .lc-stat-value");
    for (const kpi of kpis) handleKpi(kpi, backfilling);
  };

  const observer = new MutationObserver(() => { scan(); });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  scan();

  return () => {
    observer.disconnect();
    for (const el of [...activeElements]) stopElement(el, true);
    for (const id of [...activeRafs]) cancelFrame(id);
    activeElements.clear();
    activeRafs.clear();
  };
}
