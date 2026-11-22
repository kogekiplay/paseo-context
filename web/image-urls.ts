const MAX_THUMB_ENTRIES = 24;
const MAX_THUMB_BYTES = 8 * 1024 * 1024;
const DOWNSAMPLE_MIN_BYTES = 128 * 1024;
const THUMB_MAX_EDGE_PX = 640;
const THUMB_QUALITY = 0.82;

export function isNativeRuntime(): boolean {
  const g = globalThis as Record<string, unknown>;
  if (g.ReactNativeWebView || g.__PASEO_CONTEXT_TRANSPORT__ === "history") return true;
  if (typeof document !== "undefined") {
    const platform = document.documentElement?.dataset?.platform;
    if (platform === "ios" || platform === "android") return true;
  }
  return false;
}

export function thumbMaxBytes(native = isNativeRuntime()): number {
  return native ? 2 * 1024 * 1024 : 6 * 1024 * 1024;
}

export function fullMaxBytes(native = isNativeRuntime()): number {
  return native ? 8 * 1024 * 1024 : 20 * 1024 * 1024;
}

function canUseObjectUrls(): boolean {
  return typeof Blob === "function"
    && typeof URL !== "undefined"
    && typeof URL.createObjectURL === "function"
    && typeof URL.revokeObjectURL === "function";
}

function revokeSafely(url: string | null | undefined) {
  if (!url || !url.startsWith("blob:")) return;
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    try { URL.revokeObjectURL(url); } catch {}
  }
}

export function dataUrlToBlob(dataUrl: string): Blob | null {
  if (typeof Blob !== "function" || !dataUrl.startsWith("data:")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const meta = dataUrl.slice(5, comma);
  const body = dataUrl.slice(comma + 1);
  const isBase64 = /;base64$/i.test(meta);
  const mime = meta.replace(/;base64$/i, "") || "application/octet-stream";
  if (!mime.startsWith("image/")) return null;
  try {
    if (isBase64) {
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(body)], { type: mime });
  } catch {
    return null;
  }
}

async function downsampleBlob(blob: Blob): Promise<Blob> {
  if (blob.size <= DOWNSAMPLE_MIN_BYTES || !canUseObjectUrls()) return blob;
  if (typeof document === "undefined" || typeof document.createElement !== "function" || typeof Image === "undefined") {
    return blob;
  }
  const tempUrl = URL.createObjectURL(blob);
  let canvas: HTMLCanvasElement | null = null;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Image decode failed"));
      el.src = tempUrl;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    const longest = Math.max(width, height);
    if (!Number.isFinite(longest) || longest <= THUMB_MAX_EDGE_PX) return blob;
    const scale = THUMB_MAX_EDGE_PX / longest;
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));
    canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    ctx.drawImage(img, 0, 0, targetW, targetH);
    const hasAlpha = blob.type === "image/png" || blob.type === "image/webp" || blob.type === "image/gif";
    const outputType = hasAlpha ? "image/webp" : "image/jpeg";
    const activeCanvas = canvas;
    let resized = await new Promise<Blob | null>((resolve) => {
      if (typeof activeCanvas.toBlob !== "function") { resolve(null); return; }
      activeCanvas.toBlob((out) => resolve(out), outputType, THUMB_QUALITY);
    });
    // Fallback to PNG if WebP encoding is unsupported and source had alpha.
    if (hasAlpha && !resized) {
      resized = await new Promise<Blob | null>((resolve) => {
        if (typeof activeCanvas.toBlob !== "function") { resolve(null); return; }
        activeCanvas.toBlob((out) => resolve(out), "image/png");
      });
    }
    return resized && resized.size > 0 && resized.size < blob.size ? resized : blob;
  } catch {
    return blob;
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    revokeSafely(tempUrl);
  }
}

interface ThumbEntry {
  url: string;
  bytes: number;
  owned: boolean;
}

export interface ImageUrlPoolOptions {
  maxEntries?: number;
  maxBytes?: number;
}

export class ImageUrlPool {
  private readonly thumbs = new Map<string, ThumbEntry>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private thumbBytes = 0;
  private lightboxUrl: string | null = null;
  private epoch = 0;

  constructor(options: ImageUrlPoolOptions = {}) {
    this.maxEntries = options.maxEntries ?? MAX_THUMB_ENTRIES;
    this.maxBytes = options.maxBytes ?? MAX_THUMB_BYTES;
  }

  get size() { return this.thumbs.size; }
  get bytes() { return this.thumbBytes; }

  private evictOldest() {
    while (this.thumbs.size > this.maxEntries || (this.thumbBytes > this.maxBytes && this.thumbs.size > 1)) {
      const oldestKey = this.thumbs.keys().next().value!;
      const oldest = this.thumbs.get(oldestKey)!;
      this.thumbs.delete(oldestKey);
      this.thumbBytes = Math.max(0, this.thumbBytes - oldest.bytes);
      if (oldest.owned) revokeSafely(oldest.url);
    }
  }

  resolveThumb(key: string, loadDataUrl: (maxBytes: number) => Promise<string>): Promise<string> {
    const cached = this.thumbs.get(key);
    if (cached) {
      this.thumbs.delete(key);
      this.thumbs.set(key, cached);
      return Promise.resolve(cached.url);
    }
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const startEpoch = this.epoch;
    const task = (async () => {
      const raw = await loadDataUrl(thumbMaxBytes());
      if (this.epoch !== startEpoch) return "";
      if (typeof raw !== "string" || !raw) return raw;
      if (!canUseObjectUrls()) return raw;
      const parsed = dataUrlToBlob(raw);
      if (!parsed) return raw;
      const finalBlob = await downsampleBlob(parsed);
      if (this.epoch !== startEpoch) return "";
      const existing = this.thumbs.get(key);
      if (existing) {
        this.thumbs.delete(key);
        this.thumbs.set(key, existing);
        return existing.url;
      }
      const objectUrl = URL.createObjectURL(finalBlob);
      this.thumbs.set(key, { url: objectUrl, bytes: finalBlob.size, owned: true });
      this.thumbBytes += finalBlob.size;
      this.evictOldest();
      return objectUrl;
    })().finally(() => {
      if (this.pending.get(key) === task) this.pending.delete(key);
    });
    this.pending.set(key, task);
    return task;
  }

  toLightboxUrl(raw: string): string {
    if (!raw || !canUseObjectUrls()) return raw;
    const blob = dataUrlToBlob(raw);
    if (!blob) return raw;
    return URL.createObjectURL(blob);
  }

  setLightboxUrl(nextUrl: string | null) {
    if (this.lightboxUrl && this.lightboxUrl !== nextUrl) {
      revokeSafely(this.lightboxUrl);
    }
    this.lightboxUrl = nextUrl && nextUrl.startsWith("blob:") ? nextUrl : null;
  }

  clearLightbox() {
    this.setLightboxUrl(null);
  }

  clearThumbs() {
    this.epoch++;
    this.pending.clear();
    for (const entry of this.thumbs.values()) {
      if (entry.owned) revokeSafely(entry.url);
    }
    this.thumbs.clear();
    this.thumbBytes = 0;
  }

  dispose() {
    this.clearThumbs();
    this.clearLightbox();
  }
}
