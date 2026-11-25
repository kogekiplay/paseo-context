import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { record, text } from "./value";
import { MAX_IMAGE_BYTES } from "../shared/limits";

const dataHeader = /^data:image\/(?:png|jpe?g|webp|gif|avif|bmp);base64,/i;
const imageMime = /^image\/(?:png|jpe?g|webp|gif|avif|bmp)$/i;

export function imageByteLimit(value: unknown, fallback = MAX_IMAGE_BYTES) {
  return typeof value === "number" && !Number.isNaN(value)
    ? Math.min(MAX_IMAGE_BYTES, Math.max(64 * 1024, Math.floor(value))) : fallback;
}

export const imageSizeError = (bytes: number) => new Error(`Image exceeds the ${bytes / 1024 / 1024} MiB preview limit`);

const canonicalMime = (mime: string) => mime.toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const AVIF_BRANDS = new Set(["avif", "avis"]);

function matchesImage(bytes: Buffer, mime: string) {
  const ascii = (start: number, end: number) => bytes.toString("latin1", start, end);
  switch (mime) {
    case "image/png": return bytes.subarray(0, PNG.length).equals(PNG);
    case "image/jpeg": return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif": return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
    case "image/webp": return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "image/bmp": return ascii(0, 2) === "BM";
    case "image/avif": {
      if (bytes.length < 16 || ascii(4, 8) !== "ftyp") return false;
      const end = bytes.readUInt32BE(0);
      if (end < 16 || end > bytes.length || end % 4) return false;
      if (AVIF_BRANDS.has(ascii(8, 12))) return true;
      for (let offset = 16; offset < end; offset += 4) if (AVIF_BRANDS.has(ascii(offset, offset + 4))) return true;
      return false;
    }
    default: return false;
  }
}

function inside(directory: string, path: string) {
  const rel = relative(directory, path);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : null;
}

export async function antigravityImage(root: string, conversationId: string, media: unknown, maxBytes: number) {
  const { uri, mime_type } = record(media), mime = canonicalMime(text(mime_type));
  if (typeof uri !== "string" || !imageMime.test(mime)) return null;
  try {
    let requested = uri;
    if (/^file:/i.test(uri)) {
      const url = new URL(uri);
      if (url.protocol !== "file:" || url.hostname || !/^file:\/\/\//i.test(uri)) return null;
      requested = fileURLToPath(url);
    }
    if (!isAbsolute(requested) || requested.includes("\0") || /^[/\\]{2}/.test(requested)
      || requested.split(sep === "\\" ? /[/\\]/ : "/").includes("..")) return null;
    const directory = join(await realpath(join(root, "brain")), conversationId);
    const dir = await lstat(directory, { bigint: true });
    if (!dir.isDirectory() || dir.isSymbolicLink() || await realpath(directory) !== directory) return null;
    const rel = inside(directory, requested) ?? inside(resolve(root, "brain", conversationId), requested);
    if (!rel) return null;
    const parts = rel.split(sep);
    const chain = [{ path: directory, dev: dir.dev, ino: dir.ino }];
    let target = directory;
    for (const part of parts.slice(0, -1)) {
      target = join(target, part);
      const entry = await lstat(target, { bigint: true });
      if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
      chain.push({ path: target, dev: entry.dev, ino: entry.ino });
    }
    target = join(target, parts.at(-1)!);
    if (canonicalMime(`image/${extname(target).slice(1)}`) !== mime) return null;
    const expected = await lstat(target, { bigint: true });
    if (!expected.isFile()) return null;
    // Node lacks openat, so recheck each directory identity around the descriptor read.
    const sameChain = async () => {
      for (const directory of chain) {
        const entry = await lstat(directory.path, { bigint: true });
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== directory.dev || entry.ino !== directory.ino) return false;
      }
      return await realpath(directory) === directory && await realpath(target) === target;
    };
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino || !await sameChain()) return null;
      if (info.size > maxBytes) throw imageSizeError(maxBytes);
      if (!info.size) return null;
      const bytes = Buffer.allocUnsafe(Number(info.size));
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const current = await file.stat({ bigint: true });
      if (current.size > maxBytes) throw imageSizeError(maxBytes);
      const linked = await lstat(target, { bigint: true });
      if (length !== bytes.length || current.size !== info.size || current.mtimeNs !== info.mtimeNs
        || current.ctimeNs !== info.ctimeNs || linked.dev !== info.dev || linked.ino !== info.ino
        || !await sameChain() || !matchesImage(bytes, mime)) return null;
      return `data:${mime};base64,${bytes.toString("base64")}`;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof TypeError || error instanceof URIError
      || ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

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
