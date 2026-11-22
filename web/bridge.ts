interface Pending { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup(): void }
interface NativeFrameItem { hash: (serial: number) => string; rpcId?: number; groupId?: number; retries: number }

const MAX_PENDING = 128;
// Stay below Chromium's 4096-char kMaxTitleChars so title mirroring never truncates chunks.
const MAX_HISTORY_CHUNK = 3_072;
const MAX_HISTORY_TOTAL = 2 * 1024 * 1024;
const HISTORY_PROBE_TIMEOUT_MS = 600;
const HISTORY_ACK_TIMEOUT_MS = 3000;
const HISTORY_MAX_RETRIES = 2;
const HISTORY_METHODS = ["replace", "hash", "push"] as const;

const pending = new Map<number, Pending>();
let serial = 0;
const getNonce = () => (globalThis as unknown as { __PASEO_CONTEXT_NONCE__: string }).__PASEO_CONTEXT_NONCE__;
const isHistoryTransport = () => (globalThis as any).__PASEO_CONTEXT_TRANSPORT__ === "history";

const nativeQueue: NativeFrameItem[] = [];
let nativeSending = false, nativeSerial = 0, nativeGroup = 0;
let inFlightSeq: number | null = null;
let historyConfirmed = false, nativeMethodIndex = 0;
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

function resetBridgeTitleIfIdle() {
  if (!nativeQueue.length && typeof document !== "undefined" && document.title.startsWith("#paseo-context")) {
    document.title = "Paseo Context";
  }
}

function dropFrontFrame(reason: string) {
  const dropped = nativeQueue.shift();
  if (dropped?.groupId !== undefined) {
    for (let i = nativeQueue.length - 1; i >= 0; i--) {
      if (nativeQueue[i].groupId === dropped.groupId) nativeQueue.splice(i, 1);
    }
  }
  resetBridgeTitleIfIdle();
  rejectPending(dropped?.rpcId, reason);
}

function writeHistoryFrame(frame: string, method: typeof HISTORY_METHODS[number]) {
  if (typeof document !== "undefined") document.title = frame;
  if (method === "hash" && typeof location !== "undefined") {
    location.hash = frame;
    return;
  }
  if (method === "push" && typeof history.pushState === "function") {
    history.pushState(null, "", frame);
    return;
  }
  history.replaceState(null, "", frame);
}

const pumpNative = () => {
  if (nativeSending || !nativeQueue.length) return;
  nativeSending = true;
  clearAckTimer();
  const item = nativeQueue[0];
  const seq = ++nativeSerial;
  inFlightSeq = seq;
  const method = HISTORY_METHODS[nativeMethodIndex % HISTORY_METHODS.length];
  try {
    writeHistoryFrame(item.hash(seq), method);
  } catch {
    inFlightSeq = null;
    if (!historyConfirmed) nativeMethodIndex = (nativeMethodIndex + 1) % HISTORY_METHODS.length;
    dropFrontFrame("Native bridge history write failed");
    nativeSending = false;
    if (nativeQueue.length) queueMicrotask(pumpNative);
    return;
  }
  const timeoutMs = !historyConfirmed && item.retries < HISTORY_METHODS.length - 1
    ? HISTORY_PROBE_TIMEOUT_MS
    : HISTORY_ACK_TIMEOUT_MS;
  nativeAckTimer = setTimeout(() => {
    nativeAckTimer = null;
    if (!nativeSending || !nativeQueue.length) return;
    inFlightSeq = null;
    if (nativeQueue[0].retries < HISTORY_MAX_RETRIES) {
      nativeQueue[0].retries++;
      if (!historyConfirmed) nativeMethodIndex = (nativeMethodIndex + 1) % HISTORY_METHODS.length;
      nativeSending = false;
      pumpNative();
      return;
    }
    dropFrontFrame("Native bridge acknowledgement timed out");
    nativeSending = false;
    pumpNative();
  }, timeoutMs);
};

(globalThis as any).__PASEO_CONTEXT_ACK__ = (ackSeq?: string | number) => {
  if (!nativeSending) return;
  if (ackSeq !== undefined && String(ackSeq) !== String(inFlightSeq)) return;
  clearAckTimer();
  historyConfirmed = true;
  nativeQueue.shift();
  inFlightSeq = null;
  nativeSending = false;
  resetBridgeTitleIfIdle();
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
  historyConfirmed = false;
  nativeMethodIndex = 0;
  nativeSending = false;
});
export function action(name: string, payload: unknown = {}) {
  send({ type: "paseo-context:action", nonce: getNonce(), aid: ++serial, name, payload });
}
