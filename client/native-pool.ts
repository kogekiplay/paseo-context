import { AppState, Platform, type AppStateStatus } from "react-native";

export const MAX_ACTIVE_NATIVE_WEBVIEWS = 2;
export const HIDDEN_PAUSE_DELAY_MS = 5_000;
export const IOS_BACKGROUND_PAUSE_DELAY_MS = 1_500;
export const ANDROID_BACKGROUND_PAUSE_DELAY_MS = 30_000;

export function backgroundPauseDelayMs(): number {
  return Platform.OS === "ios" ? IOS_BACKGROUND_PAUSE_DELAY_MS : ANDROID_BACKGROUND_PAUSE_DELAY_MS;
}

export interface NativeWebViewPoolEntry {
  id: string;
  isVisible: () => boolean;
  pause: () => void;
  resume: () => void;
}

/**
 * Module-scoped LRU pool capping simultaneously live native WebViews
 * (WKWebView / Android WebView) and pausing them when app enters background.
 */
class NativeWebViewPool {
  private entries = new Map<string, NativeWebViewPoolEntry>();
  private activeOrder = new Map<string, NativeWebViewPoolEntry>();
  private backgroundPaused: string[] = [];
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSubscription: { remove(): void } | null = null;

  private ensureAppStateListener() {
    if (this.appStateSubscription || typeof AppState?.addEventListener !== "function") return;
    this.appStateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
      this.handleAppStateChange(nextState);
    });
  }

  private teardownAppStateListenerIfEmpty() {
    if (this.entries.size > 0) return;
    this.clearBackgroundTimer();
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    this.backgroundPaused = [];
  }

  private clearBackgroundTimer() {
    if (this.backgroundTimer !== null) {
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;
    }
  }

  handleAppStateChange(nextState: AppStateStatus) {
    if (nextState === "background") {
      if (this.backgroundTimer !== null) return;
      this.backgroundTimer = setTimeout(() => {
        this.backgroundTimer = null;
        if (AppState.currentState && AppState.currentState !== "background") return;
        if (this.activeOrder.size === 0) return;
        const activeEntries = [...this.activeOrder.values()];
        this.activeOrder.clear();
        this.backgroundPaused = activeEntries.map((entry) => entry.id);
        for (const entry of activeEntries) entry.pause();
      }, backgroundPauseDelayMs());
      return;
    }
    if (nextState === "active") {
      this.clearBackgroundTimer();
      if (this.backgroundPaused.length === 0) return;
      const toRestore = this.backgroundPaused.splice(0);
      const visible = toRestore
        .map((id) => this.entries.get(id))
        .filter((entry): entry is NativeWebViewPoolEntry => Boolean(entry && entry.isVisible()));
      const recent = visible.slice(-MAX_ACTIVE_NATIVE_WEBVIEWS);
      for (const entry of recent) {
        this.activate(entry);
        entry.resume();
      }
    }
  }

  register(entry: NativeWebViewPoolEntry) {
    this.entries.set(entry.id, entry);
    this.ensureAppStateListener();
  }

  activate(entry: NativeWebViewPoolEntry) {
    this.entries.set(entry.id, entry);
    this.ensureAppStateListener();
    this.backgroundPaused = this.backgroundPaused.filter((id) => id !== entry.id);
    this.activeOrder.delete(entry.id);
    this.activeOrder.set(entry.id, entry);
    while (this.activeOrder.size > MAX_ACTIVE_NATIVE_WEBVIEWS) {
      const oldestId = this.activeOrder.keys().next().value!;
      const oldest = this.activeOrder.get(oldestId)!;
      this.activeOrder.delete(oldestId);
      oldest.pause();
    }
  }

  deactivate(id: string) {
    this.activeOrder.delete(id);
  }

  unregister(id: string) {
    this.entries.delete(id);
    this.activeOrder.delete(id);
    this.backgroundPaused = this.backgroundPaused.filter((item) => item !== id);
    this.teardownAppStateListenerIfEmpty();
  }

  activeCount() {
    return this.activeOrder.size;
  }

  reset() {
    this.clearBackgroundTimer();
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    this.entries.clear();
    this.activeOrder.clear();
    this.backgroundPaused = [];
  }
}

export const nativeWebViewPool = new NativeWebViewPool();
