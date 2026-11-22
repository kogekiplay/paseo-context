interface Pending { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup(): void }
interface NativeFrameItem { hash: (serial: number) => string; rpcId?: number; groupId?: number; retries: number }

const MAX_PENDING = 128;
const MAX_HISTORY_CHUNK = 16_384;
const MAX_HISTORY_TOTAL = 2 * 1024 * 1024;
const HISTORY_ACK_TIMEOUT_MS = 3000;
const HISTORY_MAX_RETRIES = 1;

const pending = new Map<number, Pending>();
let serial = 0;
const getNonce = () => (globalThis as unknown as { __PASEO_CONTEXT_NONCE__: string }).__PASEO_CONTEXT_NONCE__;
const isHistoryTransport = () => (globalThis as any).__PASEO_CONTEXT_TRANSPORT__ === "history";

const nativeQueue: NativeFrameItem[] = [];
let nativeSending = false, nativeSerial = 0, nativeGroup = 0;
let inFlightSeq: number | null = null;
let nativeAckTimer: ReturnType<typeof setTimeout> | null = null;

function clearAckTimer() {
  if (nativeAckTimer !== null) {
    clearTimeout(nativeAckTimer);
    nativeAckTimer = null;
  }
}

function rejectPending(id: number | undefined, message: string) {
  if (id === undefined) return;
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  clearTimeout(request.timer);
  request.cleanup();
  request.reject(new Error(message));
}

function dropFrontFrame(reason: string) {
  const dropped = nativeQueue.shift();
  if (dropped?.groupId !== undefined) {
    for (let i = nativeQueue.length - 1; i >= 0; i--) {
      if (nativeQueue[i].groupId === dropped.groupId) nativeQueue.splice(i, 1);
    }
  }
  rejectPending(dropped?.rpcId, reason);
}

const pumpNative = () => {
  if (nativeSending || !nativeQueue.length) return;
  nativeSending = true;
  clearAckTimer();
  const item = nativeQueue[0];
  const seq = ++nativeSerial;
  inFlightSeq = seq;
  try {
    history.replaceState(null, "", item.hash(seq));
  } catch {
    inFlightSeq = null;
    dropFrontFrame("Native bridge history write failed");
    nativeSending = false;
    if (nativeQueue.length) queueMicrotask(pumpNative);
    return;
  }
  nativeAckTimer = setTimeout(() => {
    nativeAckTimer = null;
    if (!nativeSending || !nativeQueue.length) return;
    inFlightSeq = null;
    if (nativeQueue[0].retries < HISTORY_MAX_RETRIES) {
      nativeQueue[0].retries++;
      nativeSending = false;
      pumpNative();
      return;
    }
    dropFrontFrame("Native bridge acknowledgement timed out");
    nativeSending = false;
    pumpNative();
  }, HISTORY_ACK_TIMEOUT_MS);
};

(globalThis as any).__PASEO_CONTEXT_ACK__ = (ackSeq?: string | number) => {
  if (ackSeq !== undefined && inFlightSeq !== null && String(ackSeq) !== String(inFlightSeq)) return;
  clearAckTimer();
  if (nativeSending) nativeQueue.shift();
  inFlightSeq = null;
  nativeSending = false;
  pumpNative();
};

function enqueueHistory(message: unknown, rpcId?: number): boolean {
  const encoded = encodeURIComponent(JSON.stringify(message));
  if (encoded.length > MAX_HISTORY_TOTAL) return false;
  if (encoded.length <= MAX_HISTORY_CHUNK) {
    nativeQueue.push({ hash: (seq) => `#paseo-context=${seq}:${encoded}`, rpcId, retries: 0 });
  } else {
    const groupId = ++nativeGroup;
    const total = Math.ceil(encoded.length / MAX_HISTORY_CHUNK);
    for (let index = 0; index < total; index++) {
      const part = encoded.slice(index * MAX_HISTORY_CHUNK, (index + 1) * MAX_HISTORY_CHUNK);
      nativeQueue.push({
        hash: (seq) => `#paseo-context-chunk=${seq}:${groupId}:${index}:${total}:${part}`,
        rpcId,
        groupId,
        retries: 0,
      });
    }
  }
  pumpNative();
  return true;
}

export function send(message: unknown): boolean {
  if (isHistoryTransport()) return enqueueHistory(message);
  const native = (globalThis as unknown as { ReactNativeWebView?: { postMessage(value: string): void } }).ReactNativeWebView;
  if (native) native.postMessage(JSON.stringify(message));
  else parent.postMessage(message, "*");
  return true;
}
(globalThis as any).__PASEO_CONTEXT_SEND__ = send;

(globalThis as any).__PASEO_CONTEXT_RECEIVE__ = (data: unknown) => {
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));
};
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.nonce !== getNonce() || event.data?.type !== "paseo-context:result") return;
  const request = pending.get(event.data.id);
  if (!request) return;
  pending.delete(event.data.id); clearTimeout(request.timer); request.cleanup();
  if (event.data.error) request.reject(new Error(String(event.data.error)));
  else request.resolve(event.data.value);
});
export function call(route: string, payload: unknown = {}, options: { signal?: AbortSignal } = {}): Promise<any> {
  if (options.signal?.aborted) return Promise.reject(new Error("Request aborted"));
  if (pending.size >= MAX_PENDING) return Promise.reject(new Error("Too many pending context requests"));
  const id = ++serial;
  const envelope = { type: "paseo-context:rpc", nonce: getNonce(), id, route, payload };
  return new Promise((resolve, reject) => {
    const abort = () => finish(new Error("Request aborted"));
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    const finish = (error: Error) => { const request = pending.get(id); if (request) clearTimeout(request.timer); pending.delete(id); cleanup(); reject(error); };
    const timer = setTimeout(() => finish(new Error("Paseo context request timed out")), 60000);
    pending.set(id, { resolve, reject, timer, cleanup });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (isHistoryTransport()) {
      if (!enqueueHistory(envelope, id)) finish(new Error("Payload exceeds native bridge limit"));
    } else {
      send(envelope);
    }
  });
}
window.addEventListener("pagehide", () => {
  clearAckTimer();
  for (const request of pending.values()) {
    clearTimeout(request.timer); request.cleanup(); request.reject(new Error("Context view closed"));
  }
  pending.clear();
  nativeQueue.length = 0;
  inFlightSeq = null;
  nativeSending = false;
});
export function action(name: string, payload: unknown = {}) {
  send({ type: "paseo-context:action", nonce: getNonce(), aid: ++serial, name, payload });
}
