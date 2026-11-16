interface Pending { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; cleanup(): void }
const pending = new Map<number, Pending>();
let serial = 0;
const nonce = (globalThis as unknown as { __PASEO_CONTEXT_NONCE__: string }).__PASEO_CONTEXT_NONCE__;
const nativeQueue: unknown[] = [];
let nativeSending = false, nativeSerial = 0;
const pumpNative = () => {
  if (nativeSending || !nativeQueue.length) return;
  nativeSending = true;
  history.replaceState(null, "", `#paseo-context=${++nativeSerial}:${encodeURIComponent(JSON.stringify(nativeQueue[0]))}`);
};
(globalThis as any).__PASEO_CONTEXT_ACK__ = () => {
  nativeQueue.shift(); nativeSending = false; pumpNative();
};
export function send(message: unknown) {
  if ((globalThis as any).__PASEO_CONTEXT_TRANSPORT__ === "history") {
    nativeQueue.push(message); pumpNative(); return;
  }
  const native = (globalThis as unknown as { ReactNativeWebView?: { postMessage(value: string): void } }).ReactNativeWebView;
  if (native) native.postMessage(JSON.stringify(message));
  else parent.postMessage(message, "*");
}
(globalThis as any).__PASEO_CONTEXT_RECEIVE__ = (data: unknown) => {
  window.dispatchEvent(new MessageEvent("message", { data, source: window }));
};
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.nonce !== nonce || event.data?.type !== "paseo-context:result") return;
  const request = pending.get(event.data.id);
  if (!request) return;
  pending.delete(event.data.id); clearTimeout(request.timer); request.cleanup();
  if (event.data.error) request.reject(new Error(String(event.data.error)));
  else request.resolve(event.data.value);
});
export function call(route: string, payload: unknown = {}, options: { signal?: AbortSignal } = {}): Promise<any> {
  if (options.signal?.aborted) return Promise.reject(new Error("Request aborted"));
  if (pending.size >= 128) return Promise.reject(new Error("Too many pending context requests"));
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const abort = () => finish(new Error("Request aborted"));
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    const finish = (error: Error) => { const request = pending.get(id); if (request) clearTimeout(request.timer); pending.delete(id); cleanup(); reject(error); };
    const timer = setTimeout(() => finish(new Error("Paseo context request timed out")), 60000);
    pending.set(id, { resolve, reject, timer, cleanup });
    options.signal?.addEventListener("abort", abort, { once: true });
    send({ type: "paseo-context:rpc", nonce, id, route, payload });
  });
}
window.addEventListener("pagehide", () => {
  for (const request of pending.values()) {
    clearTimeout(request.timer); request.cleanup(); request.reject(new Error("Context view closed"));
  }
  pending.clear();
  nativeQueue.length = 0;
});
export function action(name: string, payload: unknown = {}) {
  send({ type: "paseo-context:action", nonce, name, payload });
}
