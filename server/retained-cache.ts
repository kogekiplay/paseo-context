interface Entry<T> { value: T; bytes: number; expires: number }

export const SESSION_IDLE_MS = 120_000;

/** Weighted LRU with a single timer for the earliest idle expiry. */
export class RetainedCache<T> {
  private entries = new Map<string, Entry<T>>();
  private weight = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt = 0;

  constructor(private limit: number, private maxWeight: number, private idleMs = SESSION_IDLE_MS,
    private onEvict?: (key: string, value: T) => void) {}

  peek(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= Date.now()) { this.delete(key); return; }
    return entry.value;
  }

  get(key: string): T | undefined {
    const value = this.peek(key);
    if (value === undefined) return;
    const entry = this.entries.get(key)!;
    this.entries.delete(key);
    entry.expires = Date.now() + this.idleMs;
    this.entries.set(key, entry);
    this.schedule();
    return value;
  }

  set(key: string, value: T, bytes: number): boolean {
    const old = this.entries.get(key);
    if (old) this.remove(key, old);
    if (bytes <= this.maxWeight) {
      this.entries.set(key, { value, bytes, expires: Date.now() + this.idleMs });
      this.weight += bytes;
    }
    this.trim();
    return this.entries.has(key);
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.remove(key, entry);
    this.schedule();
  }

  private remove(key: string, entry: Entry<T>) {
    this.entries.delete(key);
    this.weight -= entry.bytes;
    this.onEvict?.(key, entry.value);
  }

  private trim() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.limit && this.weight <= this.maxWeight && entry.expires > now) break;
      this.remove(key, entry);
    }
    this.schedule();
  }

  private schedule() {
    const next = this.entries.values().next().value?.expires ?? 0;
    if (next === this.timerAt) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = next;
    if (!next) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = 0;
      this.trim();
    }, Math.max(1, next - Date.now()));
    this.timer.unref();
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = 0;
    for (const [key, entry] of this.entries) this.remove(key, entry);
  }
}
