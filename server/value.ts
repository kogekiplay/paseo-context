export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
export const text = (value: unknown): string => typeof value === "string" ? value : "";
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
