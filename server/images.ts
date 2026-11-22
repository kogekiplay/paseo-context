import { record, text } from "./value";
import { MAX_IMAGE_BYTES } from "../shared/limits";

const dataHeader = /^data:image\/(?:png|jpe?g|webp|gif|avif|bmp);base64,/i;
const imageMime = /^image\/(?:png|jpe?g|webp|gif|avif|bmp)$/i;

export function imageByteLimit(value: unknown, fallback = MAX_IMAGE_BYTES) {
  return typeof value === "number" && !Number.isNaN(value)
    ? Math.min(MAX_IMAGE_BYTES, Math.max(64 * 1024, Math.floor(value))) : fallback;
}

export const imageSizeError = (bytes: number) => new Error(`Image exceeds the ${bytes / 1024 / 1024} MiB preview limit`);

function validBase64(value: string, start: number, maxBytes: number) {
  // Also cap the encoded representation before examining or returning it.
  if (value.length - start > Math.ceil(maxBytes / 3) * 4) throw imageSizeError(maxBytes);
  let digits = 0, padding = 0;
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 61) padding++;
    else if (code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47) {
      if (padding) return false;
      digits++;
    } else if (!/\s/.test(value[index])) return false;
  }
  if (Math.floor(digits * 3 / 4) > maxBytes) throw imageSizeError(maxBytes);
  return digits > 1 && digits % 4 !== 1 && padding <= 2 && (!padding || (digits + padding) % 4 === 0);
}

/** Resolve only image bytes/URLs retained in the selected source record. */
export function imageUrlOf(value: unknown, maxBytes = MAX_IMAGE_BYTES): string | null {
  return imageUrlAt(value, maxBytes, 0);
}

function imageUrlAt(value: unknown, maxBytes: number, depth: number): string | null {
  if (depth > 8) return null;
  if (typeof value === "string") {
    const header = dataHeader.exec(value);
    if (header) return validBase64(value, header[0].length, maxBytes) ? value : null;
    if (/^https:\/\//.test(value)) return value;
    let decoded: unknown;
    try { decoded = JSON.parse(value); } catch { return null; }
    return imageUrlAt(decoded, maxBytes, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = imageUrlAt(item, maxBytes, depth + 1); if (found) return found; }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const data = record(value), source = record(data.source);
  if (source.type === "base64" && imageMime.test(text(source.media_type)) && typeof source.data === "string"
    && validBase64(source.data, 0, maxBytes)) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  for (const key of ["image_url", "url", "source", "content", "output"]) {
    const found = imageUrlAt(data[key], maxBytes, depth + 1);
    if (found) return found;
  }
  return null;
}
