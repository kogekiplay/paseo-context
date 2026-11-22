import { ensureActive } from "./paging";

export const MIB = 1024 * 1024;
export const TIMELINE_PAGE_BYTES = 64 * MIB;
const READ_BYTES = 128 * MIB;
const READ_CONCURRENCY = 4;

interface Waiter {
  signal: AbortSignal;
  bytes: number;
  start: () => void;
  reject: (error: Error) => void;
}
interface SignalQueue { waiters: Set<Waiter>; abort: () => void }
export type AccountRead = (estimatedBytes: number) => void;

/** Reservations encompass one read, including any companion data it opens. */
export class ReadBudget {
  private waiting = new Set<Waiter>();
  private signals = new Map<AbortSignal, SignalQueue>();
  private active = 0;
  private used = 0;

  constructor(private maxBytes = READ_BYTES, private maxReads = READ_CONCURRENCY) {}

  async run<T>(bytes: number, signal: AbortSignal, read: (account: AccountRead) => Promise<T>): Promise<T> {
    ensureActive(signal);
    let reserved = this.weight(bytes);
    await new Promise<void>((start, reject) => {
      const waiter = { signal, bytes: reserved, start, reject };
      const queue = this.signals.get(signal) ?? this.watch(signal);
      queue.waiters.add(waiter);
      this.waiting.add(waiter);
      this.drain();
    });
    try {
      ensureActive(signal);
      const result = await read((estimate) => {
        const next = this.weight(estimate);
        if (next <= reserved) return;
        this.used += next - reserved;
        reserved = next;
      });
      ensureActive(signal);
      return result;
    } finally {
      this.active--;
      this.used -= reserved;
      this.drain();
    }
  }

  // A single large source may run alone so its history can still be read in full.
  private weight(bytes: number) {
    return Number.isFinite(bytes) ? Math.max(1, Math.min(this.maxBytes, bytes)) : this.maxBytes;
  }

  private watch(signal: AbortSignal): SignalQueue {
    const waiters = new Set<Waiter>();
    const abort = () => {
      this.signals.delete(signal);
      for (const waiter of waiters) {
        this.waiting.delete(waiter);
        waiter.reject(new Error("Plugin was stopped"));
      }
      waiters.clear();
      this.drain();
    };
    const queue = { waiters, abort };
    this.signals.set(signal, queue);
    signal.addEventListener("abort", abort, { once: true });
    return queue;
  }

  private drain() {
    for (const waiter of this.waiting) {
      if (this.active >= this.maxReads || this.used + waiter.bytes > this.maxBytes) break;
      this.waiting.delete(waiter);
      const queue = this.signals.get(waiter.signal)!;
      queue.waiters.delete(waiter);
      if (!queue.waiters.size) {
        waiter.signal.removeEventListener("abort", queue.abort);
        this.signals.delete(waiter.signal);
      }
      this.active++;
      this.used += waiter.bytes;
      waiter.start();
    }
  }
}

export const sessionReadBudget = new ReadBudget();
