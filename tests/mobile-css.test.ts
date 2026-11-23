import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DICTS } from "../src/client/i18n";
import { preferenceLabels } from "../client/preferences-copy";

describe("Narrow-screen CSS, build seams, and preference locale contracts", () => {
  test("web/mobile.css narrow StatsView footer selectors match StatsView.tsx DOM structure", () => {
    const mobileCss = readFileSync("web/mobile.css", "utf8");
    const statsView = readFileSync("web/vendor/statistics/StatsView.tsx", "utf8");

    expect(mobileCss).toContain(".pc-statistics { container: pc-statistics / inline-size; }");
    expect(mobileCss).toContain("@container pc-statistics (max-width: 700px)");
    expect(mobileCss).toContain(".pc-statistics > div > div:last-child");
    expect(mobileCss).toContain(".pc-statistics > div > div:last-child > span");
    expect(mobileCss).toContain(".pc-statistics > div > div:last-child > div");
    expect(mobileCss).toContain(".pc-statistics > div > div:last-child > button");
    expect(mobileCss).toContain("@container lc-card (max-width: 520px)");

    // Confirm StatsView renders the exact root -> [scroll, toolbar(span, div, button)] hierarchy.
    expect(statsView).toContain('<div className={css.root}');
    expect(statsView).toContain('role="region"');
    expect(statsView).toContain('<div className={css.toolbar}>');
    expect(statsView).toContain('<span className={css.summary}>');
    expect(statsView).toContain('<div className={css.controls}>');
    expect(statsView).toContain("<TableButton");
  });

  test("scripts/build-web.mjs omits hardcoded darwin platform and supports Android history diagnostics", () => {
    const buildWeb = readFileSync("scripts/build-web.mjs", "utf8");
    expect(buildWeb).not.toContain('<html data-platform="darwin">');
    expect(buildWeb).toContain("<!doctype html><html>");
    expect(buildWeb).toContain('globalThis.__PASEO_CONTEXT_TRANSPORT__==="history"');
    expect(buildWeb).toContain("globalThis.__PASEO_CONTEXT_BOOTED__");
    expect(buildWeb).toContain('type:"paseo-context:error"');
    expect(buildWeb).toContain('globalThis.__PASEO_CONTEXT_NONCE__="%%PASEO_CONTEXT_NONCE%%";');
  });

  test("client/preferences-copy.ts labels match src/client/i18n across all 8 locales with zero drift", () => {
    const locales = Object.keys(DICTS) as Array<keyof typeof DICTS>;
    expect(Object.keys(preferenceLabels).sort()).toEqual([...locales].sort());
    for (const locale of locales) {
      const subset = preferenceLabels[locale];
      const full = DICTS[locale] as Record<string, string>;
      for (const [key, value] of Object.entries(subset)) {
        expect(value, `${locale}:${key}`).toBe(full[key]);
      }
    }
  });
});
