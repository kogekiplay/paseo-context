import { isNewerRelease } from "../shared/core/version";
import { amountOf } from "../shared/core/decode";
import { RECOM_DATA_URL, recomsOfPayload } from "../shared/core/recoms";
import type { PlatformBalances } from "../shared/core/types";
import { recommendations } from "../shared/recommendations";
import { record, text } from "./value";
import type { PublicCache } from "./public-cache";
import { pluginVersion as VERSION } from "../shared/generated/ui-revision";
import { readPublicJson } from "./bounded-json";

export class Metadata {
  constructor(private publicCache?: PublicCache) {}
  private cache = new Map<string, { at: number; value: unknown }>();
  private busy = new Map<string, Promise<unknown>>();
  private controllers = new Set<AbortController>();
  private closed = false;
  private async cached<T>(key: string, ttl: number, read: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < ttl) return cached.value as T;
    const pending = this.busy.get(key);
    if (pending) return pending as Promise<T>;
    const next = read().then((value) => {
      if (!this.closed) this.cache.set(key, { at: Date.now(), value });
      return value;
    }).finally(() => this.busy.delete(key));
    this.busy.set(key, next);
    return next;
  }
  private async json(url: string, headers?: Record<string, string>) {
    if (this.closed) throw new Error("Plugin was stopped");
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 8000);
    timer.unref();
    try {
      const response = await fetch(url, { signal: controller.signal, headers });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 404) return null;
        throw new Error(`Metadata HTTP ${response.status}`);
      }
      return await readPublicJson(response);
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  version() {
    return this.cached("version", 3_600_000, async () => {
      try {
        const release = record(await this.json("https://api.github.com/repos/kogekiplay/paseo-context/releases/latest", { Accept: "application/vnd.github+json" }));
        const latest = text(release.tag_name).replace(/^v/, "") || VERSION;
        return { ready: true, failed: false, current: VERSION, latest, checkedAt: Date.now(), updateAvailable: isNewerRelease(latest, VERSION) };
      } catch {
        return { ready: false, failed: true, current: VERSION, checkedAt: Date.now(), updateAvailable: null };
      }
    });
  }
  async recoms() {
    const ttl = 3_600_000;
    const { recoms, degraded, expires } = await this.cached("recoms", 60_000, async () => {
      const cached = await this.publicCache?.read("recommendations");
      const previous = cached ? recomsOfPayload(cached.value) : [];
      if (cached && previous.length && Date.now() - cached.at < ttl) {
        return { recoms: previous, degraded: false, expires: cached.at + ttl };
      }
      try {
        const rows = recomsOfPayload(await this.json(RECOM_DATA_URL));
        if (rows.length) {
          const at = Date.now();
          if (!this.closed) await this.publicCache?.write("recommendations", rows, at);
          return { recoms: rows, degraded: false, expires: at + ttl };
        }
      } catch {}
      return { recoms: previous.length ? previous : recommendations, degraded: true, expires: Date.now() + 60_000 };
    });
    return { recoms, degraded, freshForMs: Math.max(0, expires - Date.now()) };
  }
  async balance(): Promise<PlatformBalances> {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) return { account: null, api: null };
    const api = await this.cached("balance", 60_000, async () => {
      try {
        const data = record(await this.json("https://api.deepseek.com/user/balance", { Authorization: `Bearer ${key}` }));
        const balances = (Array.isArray(data.balance_infos) ? data.balance_infos : []).flatMap((row) => {
          const value = record(row), currency = text(value.currency);
          const granted = amountOf(value.granted_balance), toppedUp = amountOf(value.topped_up_balance);
          if (!currency || granted === null || toppedUp === null) return [];
          const total = granted + toppedUp;
          return Number.isFinite(total) ? [{ currency, granted, toppedUp, total }] : [];
        });
        return balances.length ? { isAvailable: data.is_available === true, balances } : null;
      } catch { return null; }
    });
    return { account: null, api };
  }
  clear() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear(); this.cache.clear(); this.busy.clear();
  }
}
