import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

export const UI_LOCALE_CODES = ["de", "en", "es", "fr", "ja", "pt", "ru", "zh"];

/**
 * Extract the 8 upstream dictionaries from src/client/i18n.ts into per-locale
 * gzip+base64 blobs and replace src/client/i18n.ts in the web bundle with a
 * tiny runtime shim reading globalThis.__PASEO_CONTEXT_DICTS__.
 */
export async function localePlugin() {
  const compiled = await build({
    entryPoints: ["src/client/i18n.ts"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    target: "node22",
  });
  const mod = { exports: {} };
  new Function("exports", "module", compiled.outputFiles[0].text)(mod.exports, mod);
  const dicts = mod.exports.DICTS;
  if (!dicts || typeof dicts !== "object") {
    throw new Error("Could not extract DICTS from src/client/i18n.ts.");
  }
  const compressed = {};
  for (const code of UI_LOCALE_CODES) {
    const dict = dicts[code];
    if (!dict || typeof dict !== "object" || Object.keys(dict).length < 100) {
      throw new Error(`Upstream locale "${code}" missing or incomplete in src/client/i18n.ts.`);
    }
    compressed[code] = gzipSync(Buffer.from(JSON.stringify(dict)), { level: 9 }).toString("base64");
  }
  await writeFile(
    "shared/generated/locales.ts",
    `export const upstreamLocalesGzip: Record<string, string> = ${JSON.stringify(compressed)};\n`,
  );
  const shim = [
    "const dicts = globalThis.__PASEO_CONTEXT_DICTS__ || {};",
    "export const DICTS = dicts;",
    ...UI_LOCALE_CODES.map((code) => `export const DICT_${code.toUpperCase()} = dicts.${code} || {};`),
  ].join("\n");
  return {
    compressed,
    plugin: {
      name: "on-demand-ui-locales",
      setup(pluginBuild) {
        pluginBuild.onLoad({ filter: /src[\\/]client[\\/]i18n\.ts$/ }, () => ({
          contents: shim,
          loader: "js",
        }));
      },
    },
  };
}
