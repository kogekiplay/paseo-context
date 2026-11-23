import { describe, expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { normalizeUiLocale, uiDocument } from "../server/assets";
import { ContextService } from "../server/service";
import { UiRoutes } from "../server/ui-routes";
import { upstreamLocalesGzip } from "../shared/generated/locales";

const ALL_LOCALES = ["de", "en", "es", "fr", "ja", "pt", "ru", "zh"] as const;

function extractInjectedDicts(html: string): Record<string, Record<string, string>> {
  const marker = "globalThis.__PASEO_CONTEXT_DICTS__=";
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const rest = html.slice(start + marker.length);
  const end = rest.indexOf(";const sendDiag=");
  expect(end).toBeGreaterThan(0);
  return JSON.parse(rest.slice(0, end));
}

describe("uiDocument per-locale injection and standalone statistics bundle", () => {
  test("normalizes supported locales and falls back to en for unknown codes", () => {
    expect(Object.keys(upstreamLocalesGzip).sort()).toEqual([...ALL_LOCALES]);
    expect(normalizeUiLocale("zh-CN")).toBe("zh");
    expect(normalizeUiLocale("ZH-tw")).toBe("zh");
    expect(normalizeUiLocale("ja-JP")).toBe("ja");
    expect(normalizeUiLocale("pt-BR")).toBe("pt");
    expect(normalizeUiLocale("de")).toBe("de");
    expect(normalizeUiLocale("ko-KR")).toBe("en");
    expect(normalizeUiLocale("")).toBe("en");
    expect(normalizeUiLocale(undefined)).toBe("en");
  });

  test("full variant injects only en (default) or en + target locale, never all 8", () => {
    const enHtml = uiDocument();
    expect(enHtml).toContain('globalThis.__PASEO_CONTEXT_NONCE__="%%PASEO_CONTEXT_NONCE%%";');
    expect(enHtml).not.toContain("%%PASEO_CONTEXT_DICTS%%");
    const enDicts = extractInjectedDicts(enHtml);
    expect(Object.keys(enDicts)).toEqual(["en"]);
    expect(Object.keys(enDicts.en).length).toBeGreaterThan(100);

    // Unknown locale produces identical output to en.
    expect(uiDocument({ variant: "full", locale: "ko-KR" })).toBe(enHtml);

    // Every non-en locale injects strictly ["en", code] with full dictionary keys.
    for (const code of ALL_LOCALES) {
      if (code === "en") continue;
      const html = uiDocument({ variant: "full", locale: `${code}-REGION` });
      expect(html).not.toContain("%%PASEO_CONTEXT_DICTS%%");
      const dicts = extractInjectedDicts(html);
      expect(Object.keys(dicts).sort()).toEqual(["en", code].sort());
      expect(Object.keys(dicts[code]).length).toBeGreaterThan(100);
      for (const other of ALL_LOCALES) {
        if (other !== "en" && other !== code) expect(dicts[other]).toBeUndefined();
      }
    }
  });

  test("statistics variant is a standalone lightweight document without KaTeX fonts or i18n placeholder", () => {
    const fullEn = uiDocument({ variant: "full", locale: "en" });
    const stats = uiDocument({ variant: "statistics" });
    expect(stats).toContain('globalThis.__PASEO_CONTEXT_NONCE__="%%PASEO_CONTEXT_NONCE%%";');
    expect(stats).not.toContain("%%PASEO_CONTEXT_DICTS%%");
    expect(stats).not.toContain("__PASEO_CONTEXT_DICTS__");
    expect(stats).not.toContain("KaTeX_Main");
    expect(stats.length).toBeLessThan(fullEn.length * 0.5);
  });

  test("UiRoutes forwards ui.document variant and locale to uiDocument", async () => {
    const service = new ContextService();
    const routes = new UiRoutes(service);
    try {
      const paseo = {} as PaseoApi;
      const stats = await routes.handle("ui.document", { variant: "statistics" }, paseo);
      expect(stats).toBe(uiDocument({ variant: "statistics" }));
      const ja = await routes.handle("ui.document", { variant: "full", locale: "ja-JP" }, paseo);
      expect(ja).toBe(uiDocument({ variant: "full", locale: "ja" }));
      const fallback = await routes.handle("ui.document", {}, paseo);
      expect(fallback).toBe(uiDocument({ variant: "full", locale: "en" }));
    } finally {
      routes.clear();
      service.clear();
    }
  });
});
