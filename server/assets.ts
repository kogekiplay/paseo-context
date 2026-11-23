import { gunzipSync } from "node:zlib";
import { upstreamHtmlGzip, upstreamStatisticsHtmlGzip } from "../shared/generated/upstream-ui";
import { upstreamLocalesGzip } from "../shared/generated/locales";

export type UiDocumentVariant = "full" | "statistics";

const SUPPORTED_LOCALES = new Set(Object.keys(upstreamLocalesGzip));

let fullTemplate: string | undefined;
let statisticsDocument: string | undefined;
const localeJsonCache = new Map<string, string>();

export function normalizeUiLocale(locale?: string): string {
  const code = (locale ?? "").toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.has(code) ? code : "en";
}

function localeJson(code: string): string {
  let cached = localeJsonCache.get(code);
  if (cached !== undefined) return cached;
  const encoded = upstreamLocalesGzip[code] ?? upstreamLocalesGzip.en;
  cached = gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
  localeJsonCache.set(code, cached);
  return cached;
}

/** Static bundled UI only. Native clients do not need a DOM or a gzip decoder. */
export function uiDocument(options?: { variant?: UiDocumentVariant; locale?: string }): string {
  if (options?.variant === "statistics") {
    return statisticsDocument ??= gunzipSync(Buffer.from(upstreamStatisticsHtmlGzip, "base64")).toString("utf8");
  }
  const template = fullTemplate ??= gunzipSync(Buffer.from(upstreamHtmlGzip, "base64")).toString("utf8");
  const lang = normalizeUiLocale(options?.locale);
  const dictsJson = lang === "en"
    ? `{"en":${localeJson("en")}}`
    : `{"en":${localeJson("en")},${JSON.stringify(lang)}:${localeJson(lang)}}`;
  const safeJson = dictsJson.replace(/</g, "\\u003c");
  return template.replace("%%PASEO_CONTEXT_DICTS%%", () => safeJson);
}
