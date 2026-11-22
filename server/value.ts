export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
export const text = (value: unknown): string => typeof value === "string" ? value : "";

/** Copy the slice out of V8's original string. UTF-16 preserves exact code units. */
export function detachSlice(value: string, limit = value.length): string {
  return Buffer.from(value.slice(0, limit), "utf16le").toString("utf16le");
}

export function detachPreview(value: string, limit: number): string {
  const length = Math.min(value.length, Math.trunc(limit));
  if (!(length > 0)) return "";
  const bytes = Buffer.allocUnsafe(length * 2);
  const end = Math.min(value.length, Math.trunc(limit * 4));
  let offset = 0, previousWasSpace = false;
  for (let index = 0; index < end && offset < bytes.length; index++) {
    const code = value.charCodeAt(index);
    // ECMAScript whitespace and line terminators. Matching a sliced prefix
    // with a regexp can retain the source through RegExp.input.
    const space = code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0x1680
      || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f
      || code === 0x205f || code === 0x3000 || code === 0xfeff;
    if (space && previousWasSpace) continue;
    offset = bytes.writeUInt16LE(space ? 0x20 : code, offset);
    previousWasSpace = space;
  }
  return bytes.toString("utf16le", 0, offset);
}

export const stringBytes = (value?: string | null) => value ? 24 + value.length * 2 : 0;

export function stringIndexBytes(keys: Iterable<string>): number {
  let bytes = 0;
  for (const key of keys) bytes += 56 + stringBytes(key);
  return bytes;
}

export const timestamp = (value: unknown): number => {
  const n = typeof value === "number" ? value : Date.parse(text(value));
  return Number.isFinite(n) ? n : 0;
};
export function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(printable).join("\n");
  const r = record(value);
  if (typeof r.text === "string") return r.text;
  if (typeof r.thinking === "string") return r.thinking;
  return value === undefined || value === null ? "" : JSON.stringify(value, null, 2);
}
export function parseArgs(value: unknown): RecordValue {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return { input: value }; }
}
