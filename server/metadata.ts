import { isNewerRelease } from "../shared/core/version";
import { recomsOfPayload } from "../shared/core/recoms";
import { recommendations } from "../shared/recommendations";
import { record, text } from "./value";

export const VERSION = "0.2.3";
export class Metadata {
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
    try {
      const response = await fetch(url, { signal: controller.signal, headers });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Metadata HTTP ${response.status}`);
      return await response.json();
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
  recoms() {
    return this.cached("recoms", 1_800_000, async () => {
      try {
        const rows = recomsOfPayload(await this.json("https://raw.githubusercontent.com/bowenliang123/dsh-context/main/data/recoms.json"));
        return rows.length ? rows : recommendations;
      } catch { return recommendations; }
    });
  }
  balance() {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) return Promise.resolve(null);
    return this.cached("balance", 60_000, async () => {
      try {
        const data = record(await this.json("https://api.deepseek.com/user/balance", { Authorization: `Bearer ${key}` }));
        const balances = (Array.isArray(data.balance_infos) ? data.balance_infos : []).flatMap((row) => {
          const value = record(row), currency = text(value.currency);
          const granted = Number(value.granted_balance), toppedUp = Number(value.topped_up_balance);
          return currency && Number.isFinite(granted) && Number.isFinite(toppedUp) ? [{ currency, granted, toppedUp, total: granted + toppedUp }] : [];
        });
        return balances.length ? { isAvailable: data.is_available === true, balances } : null;
      } catch { return null; }
    });
  }
  clear() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear(); this.cache.clear(); this.busy.clear();
  }
}
