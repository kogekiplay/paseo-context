import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dataUrlToBlob, fullMaxBytes, ImageUrlPool, isNativeRuntime, thumbMaxBytes } from "../web/image-urls";

const saved = {
  createObjectURL: (globalThis.URL as any)?.createObjectURL,
  revokeObjectURL: (globalThis.URL as any)?.revokeObjectURL,
  document: (globalThis as any).document,
  Image: (globalThis as any).Image,
  ReactNativeWebView: (globalThis as any).ReactNativeWebView,
};

let createdUrls: Array<{ url: string; blob: Blob }> = [];
let revokedUrls: string[] = [];

beforeEach(() => {
  createdUrls = [];
  revokedUrls = [];
  (globalThis.URL as any).createObjectURL = (blob: Blob) => {
    const url = `blob:img-${createdUrls.length + 1}`;
    createdUrls.push({ url, blob });
    return url;
  };
  (globalThis.URL as any).revokeObjectURL = (url: string) => { revokedUrls.push(url); };
});

afterEach(() => {
  (globalThis.URL as any).createObjectURL = saved.createObjectURL;
  (globalThis.URL as any).revokeObjectURL = saved.revokeObjectURL;
  if (saved.document === undefined) delete (globalThis as any).document; else (globalThis as any).document = saved.document;
  if (saved.Image === undefined) delete (globalThis as any).Image; else (globalThis as any).Image = saved.Image;
  if (saved.ReactNativeWebView === undefined) delete (globalThis as any).ReactNativeWebView; else (globalThis as any).ReactNativeWebView = saved.ReactNativeWebView;
  delete (globalThis as any).__PASEO_CONTEXT_TRANSPORT__;
});

function pngDataUrl(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  bytes.fill(65);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

describe("web/image-urls Blob pool and downsampling", () => {
  test("computes native vs web maxBytes limits", () => {
    expect(isNativeRuntime()).toBe(false);
    expect(thumbMaxBytes()).toBe(6 * 1024 * 1024);
    expect(fullMaxBytes()).toBe(20 * 1024 * 1024);
    (globalThis as any).__PASEO_CONTEXT_TRANSPORT__ = "history";
    expect(isNativeRuntime()).toBe(true);
    expect(thumbMaxBytes()).toBe(2 * 1024 * 1024);
    expect(fullMaxBytes()).toBe(8 * 1024 * 1024);
  });

  test("converts data URL to Blob ObjectURL, enforces LRU entry & byte caps, and revokes on eviction/clear/dispose", async () => {
    const blob = dataUrlToBlob(pngDataUrl(64));
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe("image/png");
    expect(blob!.size).toBe(64);
    expect(dataUrlToBlob("https://example.invalid/a.png")).toBeNull();

    const pool = new ImageUrlPool({ maxEntries: 2, maxBytes: 150 });
    const u1 = await pool.resolveThumb("s1\0a1", async () => pngDataUrl(64));
    const u2 = await pool.resolveThumb("s1\0a2", async () => pngDataUrl(64));
    expect(u1).toBe("blob:img-1");
    expect(u2).toBe("blob:img-2");
    expect(pool.size).toBe(2);

    // Cache hit refreshes LRU and does not invoke loader again.
    const loader = vi.fn(async () => pngDataUrl(64));
    expect(await pool.resolveThumb("s1\0a1", loader)).toBe("blob:img-1");
    expect(loader).not.toHaveBeenCalled();

    // Inserting a 3rd entry evicts least-recently-used u2 and revokes it.
    const u3 = await pool.resolveThumb("s1\0a3", async () => pngDataUrl(64));
    expect(u3).toBe("blob:img-3");
    expect(revokedUrls).toEqual(["blob:img-2"]);

    // Lightbox URL lifecycle: replacing and clearing revokes previous blob URL.
    const lb1 = pool.toLightboxUrl(pngDataUrl(80));
    pool.setLightboxUrl(lb1);
    const lb2 = pool.toLightboxUrl(pngDataUrl(80));
    pool.setLightboxUrl(lb2);
    expect(revokedUrls).toContain(lb1);
    pool.clearLightbox();
    expect(revokedUrls).toContain(lb2);

    // Dispose revokes all remaining thumbnail ObjectURLs.
    pool.dispose();
    expect(pool.size).toBe(0);
    expect(pool.bytes).toBe(0);
    expect(revokedUrls).toContain(u1);
    expect(revokedUrls).toContain(u3);
  });

  test("downsamples thumbnails > 128KB via offscreen canvas and immediately revokes temporary full-size Blob URL", async () => {
    const drawImage = vi.fn();
    let canvasWidth = 0;
    let canvasHeight = 0;
    (globalThis as any).Image = class MockImage {
      naturalWidth = 2000;
      naturalHeight = 1000;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    };
    (globalThis as any).document = {
      documentElement: { dataset: {} },
      createElement: (tag: string) => {
        if (tag !== "canvas") return {};
        return {
          get width() { return canvasWidth; },
          set width(v: number) { canvasWidth = v; },
          get height() { return canvasHeight; },
          set height(v: number) { canvasHeight = v; },
          getContext: () => ({ drawImage }),
          toBlob: (cb: (b: Blob | null) => void, type: string) => {
            cb(new Blob([new Uint8Array(4096)], { type }));
          },
        };
      },
    };

    const pool = new ImageUrlPool();
    const result = await pool.resolveThumb("s1\0big", async () => pngDataUrl(150 * 1024));
    // First created ObjectURL was temp full-size blob (blob:img-1) and MUST be revoked immediately.
    expect(revokedUrls).toContain("blob:img-1");
    // Final cached ObjectURL is the downsampled 4KB blob (blob:img-2) scaled to 640x320.
    expect(result).toBe("blob:img-2");
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 640, 320);
    expect(pool.bytes).toBe(4096);
    pool.dispose();
  });

  test("gracefully falls back to raw data URL when URL.createObjectURL is unavailable", async () => {
    (globalThis.URL as any).createObjectURL = undefined;
    const pool = new ImageUrlPool();
    const raw = pngDataUrl(32);
    expect(await pool.resolveThumb("s1\0a", async () => raw)).toBe(raw);
    expect(pool.toLightboxUrl(raw)).toBe(raw);
  });

  test("deduplicates concurrent resolveThumb calls without revoking live URLs, returns empty string on stale clear, and zeroes canvas on error", async () => {
    const pool = new ImageUrlPool();
    let resolveLoad!: (value: string) => void;
    const loader = vi.fn(() => new Promise<string>((resolve) => { resolveLoad = resolve; }));

    const p1 = pool.resolveThumb("s1\0dup", loader);
    const p2 = pool.resolveThumb("s1\0dup", loader);
    expect(loader).toHaveBeenCalledTimes(1);
    resolveLoad(pngDataUrl(64));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("blob:img-1");
    expect(r2).toBe("blob:img-1");
    expect(revokedUrls).toHaveLength(0);

    // Stale resolve after clearThumbs returns "" instead of leaking raw Base64.
    let resolveStale!: (value: string) => void;
    const stalePromise = pool.resolveThumb("s1\0stale", () => new Promise<string>((resolve) => { resolveStale = resolve; }));
    pool.clearThumbs();
    resolveStale(pngDataUrl(64));
    expect(await stalePromise).toBe("");

    // Canvas buffer is zeroed in finally even when getContext("2d") returns null.
    let canvasW = 0, canvasH = 0;
    (globalThis as any).Image = class MockImage {
      naturalWidth = 1200;
      naturalHeight = 800;
      onload: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    };
    (globalThis as any).document = {
      documentElement: { dataset: {} },
      createElement: () => ({
        get width() { return canvasW; },
        set width(v: number) { canvasW = v; },
        get height() { return canvasH; },
        set height(v: number) { canvasH = v; },
        getContext: () => null,
      }),
    };
    const fallbackUrl = await pool.resolveThumb("s1\0noctx", async () => pngDataUrl(150 * 1024));
    expect(fallbackUrl.startsWith("blob:")).toBe(true);
    expect(canvasW).toBe(0);
    expect(canvasH).toBe(0);
    pool.dispose();
  });
});
