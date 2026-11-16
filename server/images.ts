import { record, text } from "./value";
import { MAX_IMAGE_BASE64_CHARS } from "../shared/limits";

/** Resolve only image bytes/URLs retained in the selected source record. */
export function imageUrlOf(value: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof value === "string") {
    if (value.startsWith("data:image/") && value.length - value.indexOf(",") - 1 > MAX_IMAGE_BASE64_CHARS) throw new Error("Image exceeds the 20 MiB preview limit");
    if (/^data:image\/(?:png|jpe?g|webp|gif|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(value)) return value;
    if (/^https:\/\//.test(value)) return value;
    try { return imageUrlOf(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = imageUrlOf(item, depth + 1); if (found) return found; }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const data = record(value), source = record(data.source);
  if (source.type === "base64" && /^image\/(?:png|jpe?g|webp|gif|avif|bmp)$/i.test(text(source.media_type)) && typeof source.data === "string") {
    if (source.data.length > MAX_IMAGE_BASE64_CHARS) throw new Error("Image exceeds the 20 MiB preview limit");
    return imageUrlOf(`data:${source.media_type};base64,${source.data}`, depth + 1);
  }
  for (const key of ["image_url", "url", "source", "content", "output"]) {
    const found = imageUrlOf(data[key], depth + 1);
    if (found) return found;
  }
  return null;
}
