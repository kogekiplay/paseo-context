import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Listener = (event: any) => void;

const savedGlobals = {
  window: (globalThis as any).window,
  parent: (globalThis as any).parent,
  history: (globalThis as any).history,
  MessageEvent: (globalThis as any).MessageEvent,
};

let listeners: Record<string, Listener[]> = {};
let historyHashes: string[] = [];
let replaceStateImpl: (state: unknown, title: string, url?: string | null) => void;

function emit(type: string, event: any) {
  for (const fn of [...(listeners[type] ?? [])]) fn(event);
}

beforeEach(() => {
  vi.resetModules();
  listeners = {};
  historyHashes = [];
  replaceStateImpl = (_state, _title, url) => { if (typeof url === "string") historyHashes.push(url); };
  const win = {
    addEventListener: (type: string, fn: Listener) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: (type: string, fn: Listener) => { listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn); },
    dispatchEvent: (event: any) => { emit(event.type, event); return true; },
    postMessage: vi.fn(),
  };
  (globalThis as any).window = win;
  (globalThis as any).parent = win;
  (globalThis as any).history = { replaceState: (...args: [unknown, string, string?]) => replaceStateImpl(...args) };
  (globalThis as any).MessageEvent = class MockMessageEvent {
    type: string;
    data: unknown;
    source: unknown;
    constructor(type: string, init: { data?: unknown; source?: unknown } = {}) {
      this.type = type;
      this.data = init.data;
      this.source = init.source;
    }
  };
  (globalThis as any).__PASEO_CONTEXT_NONCE__ = "nonce-1";
  (globalThis as any).__PASEO_CONTEXT_TRANSPORT__ = "history";
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).__PASEO_CONTEXT_NONCE__;
  delete (globalThis as any).__PASEO_CONTEXT_TRANSPORT__;
  delete (globalThis as any).__PASEO_CONTEXT_ACK__;
  delete (globalThis as any).__PASEO_CONTEXT_RECEIVE__;
  delete (globalThis as any).__PASEO_CONTEXT_SEND__;
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete (globalThis as any)[key];
    else (globalThis as any)[key] = value;
  }
});

describe("web/bridge history transport & web/grammars backoff", () => {
  test("recovers from replaceState throw and ACK timeout without deadlocking Android queue", async () => {
    vi.useFakeTimers();
    const bridge = await import("../web/bridge");

    // 1. replaceState throws on first RPC -> rejects first RPC and immediately sends second.
    let failOnce = true;
    replaceStateImpl = (_s, _t, url) => {
      if (failOnce) { failOnce = false; throw new Error("URL blocked"); }
      if (typeof url === "string") historyHashes.push(url);
    };
    const first = bridge.call("bootstrap", { step: 1 });
    const second = bridge.call("bootstrap", { step: 2 });
    await expect(first).rejects.toThrow("history write failed");
    await Promise.resolve();
    expect(historyHashes).toHaveLength(1);
    expect(historyHashes[0]).toContain("#paseo-context=");

    // 2. Missing ACK retries once after 3000ms, then drops & unblocks third message.
    const secondCheck = expect(second).rejects.toThrow("acknowledgement timed out");
    const third = bridge.call("bootstrap", { step: 3 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(historyHashes).toHaveLength(2); // retried with fresh serial
    await vi.advanceTimersByTimeAsync(3000);
    await secondCheck;
    expect(historyHashes).toHaveLength(3); // third message pumped

    // Deliver ACK and result for third message.
    (globalThis as any).__PASEO_CONTEXT_ACK__();
    (globalThis as any).__PASEO_CONTEXT_RECEIVE__({ type: "paseo-context:result", nonce: "nonce-1", id: 3, value: { ok: 3 } });
    await expect(third).resolves.toEqual({ ok: 3 });
  });

  test("chunks large payloads, rejects oversized payloads > 2MiB, and resets nativeSending on pagehide", async () => {
    const bridge = await import("../web/bridge");

    // Oversized payload rejects immediately without touching history.
    await expect(bridge.call("clipboard.write", { text: "x".repeat(2_200_000) })).rejects.toThrow("exceeds native bridge limit");
    expect(historyHashes).toHaveLength(0);

    // Multi-chunk payload (> 16KB) splits into #paseo-context-chunk= frames.
    const chunked = bridge.call("clipboard.write", { text: "a".repeat(20_000) });
    expect(historyHashes).toHaveLength(1);
    expect(historyHashes[0]).toMatch(/^#paseo-context-chunk=\d+:\d+:0:2:/);
    (globalThis as any).__PASEO_CONTEXT_ACK__();
    expect(historyHashes).toHaveLength(2);
    expect(historyHashes[1]).toMatch(/^#paseo-context-chunk=\d+:\d+:1:2:/);

    // pagehide rejects pending requests and resets nativeSending so subsequent sends work.
    emit("pagehide", { type: "pagehide" });
    await expect(chunked).rejects.toThrow("Context view closed");

    bridge.send({ type: "paseo-context:ready", nonce: "nonce-1" });
    expect(historyHashes).toHaveLength(3);
  });

  test("enforces 128 pending RPC cap and web/grammars deduplicates in-flight + backs off on error", async () => {
    vi.useFakeTimers();
    (globalThis as any).__PASEO_CONTEXT_TRANSPORT__ = undefined;
    const bridge = await import("../web/bridge");
    const grammars = await import("../web/grammars");

    // In-flight deduplication: two parallel calls share one RPC.
    const p1 = grammars.loadGrammar("typescript");
    const p2 = grammars.loadGrammar("typescript");
    expect((globalThis as any).parent.postMessage).toHaveBeenCalledTimes(1);
    const sentId = (globalThis as any).parent.postMessage.mock.calls[0][0].id;
    (globalThis as any).__PASEO_CONTEXT_RECEIVE__({ type: "paseo-context:result", nonce: "nonce-1", id: sentId, error: "boom" });
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");

    // Backoff rejects immediately during cooldown without sending another RPC.
    await expect(grammars.loadGrammar("typescript")).rejects.toThrow("backed off");
    expect((globalThis as any).parent.postMessage).toHaveBeenCalledTimes(1);

    // After 5s cooldown, retries normally.
    await vi.advanceTimersByTimeAsync(5001);
    const p3 = grammars.loadGrammar("typescript");
    expect((globalThis as any).parent.postMessage).toHaveBeenCalledTimes(2);
    const retryId = (globalThis as any).parent.postMessage.mock.calls[1][0].id;
    (globalThis as any).__PASEO_CONTEXT_RECEIVE__({ type: "paseo-context:result", nonce: "nonce-1", id: retryId, value: { name: "ts" } });
    await expect(p3).resolves.toEqual({ default: { name: "ts" } });

    // 128 pending cap.
    const requests = Array.from({ length: 128 }, (_, i) => bridge.call("ping", { i }));
    await expect(bridge.call("ping", { overflow: true })).rejects.toThrow("Too many pending");
    emit("pagehide", { type: "pagehide" });
    await Promise.allSettled(requests);
  });

  test("ignores stale ACKs from an earlier retry serial so queued frames stay synchronized", async () => {
    vi.useFakeTimers();
    const bridge = await import("../web/bridge");
    const first = bridge.call("ping", { n: 1 });
    const second = bridge.call("ping", { n: 2 });
    expect(historyHashes).toHaveLength(1);
    const seq1 = /^#paseo-context=(\d+):/.exec(historyHashes[0])![1];

    // Retry fires after 3000ms with seq2.
    await vi.advanceTimersByTimeAsync(3000);
    expect(historyHashes).toHaveLength(2);
    const seq2 = /^#paseo-context=(\d+):/.exec(historyHashes[1])![1];
    expect(seq2).not.toBe(seq1);

    // Delayed ACK for seq1 must be ignored while seq2 is in flight.
    (globalThis as any).__PASEO_CONTEXT_ACK__(seq1);
    expect(historyHashes).toHaveLength(2);

    // Matching ACK for seq2 pops Frame 1 and pumps Frame 2 with seq3.
    (globalThis as any).__PASEO_CONTEXT_ACK__(seq2);
    expect(historyHashes).toHaveLength(3);
    const seq3 = /^#paseo-context=(\d+):/.exec(historyHashes[2])![1];

    // Duplicate ACK for seq2 must not prematurely pop Frame 2.
    (globalThis as any).__PASEO_CONTEXT_ACK__(seq2);
    expect(historyHashes).toHaveLength(3);
    (globalThis as any).__PASEO_CONTEXT_ACK__(seq3);

    (globalThis as any).__PASEO_CONTEXT_RECEIVE__({ type: "paseo-context:result", nonce: "nonce-1", id: 1, value: "one" });
    (globalThis as any).__PASEO_CONTEXT_RECEIVE__({ type: "paseo-context:result", nonce: "nonce-1", id: 2, value: "two" });
    await expect(first).resolves.toBe("one");
    await expect(second).resolves.toBe("two");
  });
});
