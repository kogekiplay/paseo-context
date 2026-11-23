import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { writeNotices } from "./notices.mjs";
import { grammarPlugin } from "./grammars.mjs";
import { localePlugin } from "./locales.mjs";
import { createHash } from "node:crypto";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const entry = resolve("src/client/styles/tailwind.css");
const compiler = await compile(await readFile(entry, "utf8"), { base: dirname(entry), onDependency() {} });
const scanner = new Scanner({ sources: compiler.sources });
await mkdir(".tmp/web", { recursive: true });
await mkdir("shared/generated", { recursive: true });
await writeFile(".tmp/web/tailwind.css", compiler.build(scanner.scan()));

const grammars = await grammarPlugin();
const locales = await localePlugin();

const commonBuild = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120", "safari17"],
  jsx: "automatic",
  minify: process.env.PASEO_CONTEXT_DEBUG !== "1",
  legalComments: "linked",
  metafile: true,
  define: {
    "process.env.NODE_ENV": '"production"',
    __PASEO_CONTEXT_VERSION__: JSON.stringify(pkg.version),
    __PASEO_CONTEXT_REPO__: JSON.stringify(pkg.homepage),
  },
  loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl", ".svg": "dataurl" },
};

const result = await build({
  ...commonBuild,
  entryPoints: ["web/main.tsx"],
  outfile: ".tmp/web/app.js",
  plugins: [grammars, locales.plugin, {
    name: "modern-font-formats",
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: /katex\.min\.css$/ }, async ({ path }) => ({
        contents: (await readFile(path, "utf8")).replace(/,url\([^)]*\.(?:woff|ttf)\)\s*format\("[^"]+"\)/g, ""),
        loader: "css", resolveDir: dirname(path),
      }));
    },
  }],
});

const statisticsTrimPlugin = {
  name: "statistics-lightweight-katex",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^katex\/dist\/katex\.min\.css$/ }, () => ({
      path: "katex-empty-css",
      namespace: "paseo-stats-trim",
    }));
    pluginBuild.onResolve({ filter: /^katex$/ }, () => ({
      path: "katex-plain-shim",
      namespace: "paseo-stats-trim",
    }));
    pluginBuild.onLoad({ filter: /^katex-empty-css$/, namespace: "paseo-stats-trim" }, () => ({
      contents: "",
      loader: "css",
    }));
    pluginBuild.onLoad({ filter: /^katex-plain-shim$/, namespace: "paseo-stats-trim" }, () => ({
      contents: `export default { renderToString(value, opts) { const text = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); const body = '<span class="katex-plain">' + text + '</span>'; return opts && opts.displayMode ? '<div class="katex-display">' + body + '</div>' : body; } };`,
      loader: "js",
    }));
  },
};

const statsResult = await build({
  ...commonBuild,
  entryPoints: ["web/statistics-entry.tsx"],
  outfile: ".tmp/web/statistics.js",
  plugins: [grammars, statisticsTrimPlugin],
});

const css = await readFile(".tmp/web/app.css", "utf8");
const js = await readFile(".tmp/web/app.js", "utf8");
const statsCss = await readFile(".tmp/web/statistics.css", "utf8");
const statsJs = await readFile(".tmp/web/statistics.js", "utf8");

const diagnostics = `const sendDiag=(data)=>{if(globalThis.__PASEO_CONTEXT_SEND__){globalThis.__PASEO_CONTEXT_SEND__(data);return}if(globalThis.__PASEO_CONTEXT_TRANSPORT__==="history"){try{history.replaceState(null,"","#paseo-context=fatal:"+encodeURIComponent(JSON.stringify(data)))}catch{}return}if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(data));else parent.postMessage(data,"*")};const reportFatal=(message)=>{const text=String(message).slice(0,1024);document.title="Paseo Context error: "+text;sendDiag({type:"paseo-context:fatal",nonce:globalThis.__PASEO_CONTEXT_NONCE__,message:text})};const reportRuntime=(message)=>{const text=String(message).slice(0,1024);const box=document.getElementById("pc-error");if(box)box.textContent=text;sendDiag({type:"paseo-context:error",nonce:globalThis.__PASEO_CONTEXT_NONCE__,message:text})};addEventListener("error",e=>reportFatal(e.message||String(e.error||"Script error")));addEventListener("unhandledrejection",e=>{const text=e.reason?.message??e.reason??"Unhandled rejection";if(globalThis.__PASEO_CONTEXT_BOOTED__)reportRuntime(text);else reportFatal(text)});`;

function wrapHtml(styleText, scriptText, extraPrefix = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-%%PASEO_CONTEXT_NONCE%%' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; connect-src 'none';"><style>${styleText.replace(/<\/style/gi, "<\\/style")}</style></head><body><div id="root"></div><script nonce="%%PASEO_CONTEXT_NONCE%%">globalThis.__PASEO_CONTEXT_NONCE__="%%PASEO_CONTEXT_NONCE%%";${extraPrefix}${diagnostics}${scriptText.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}

const html = wrapHtml(css, js, "globalThis.__PASEO_CONTEXT_DICTS__=%%PASEO_CONTEXT_DICTS%%;");
const statisticsHtml = wrapHtml(statsCss, statsJs);

const upstreamHtmlGzip = gzipSync(Buffer.from(html), { level: 9 }).toString("base64");
const upstreamStatisticsHtmlGzip = gzipSync(Buffer.from(statisticsHtml), { level: 9 }).toString("base64");
const revisionHash = createHash("sha256")
  .update(html)
  .update("\0")
  .update(statisticsHtml)
  .update("\0")
  .update(JSON.stringify(locales.compressed))
  .digest("hex");

await writeFile(
  "shared/generated/upstream-ui.ts",
  `export const upstreamHtmlGzip = ${JSON.stringify(upstreamHtmlGzip)};\nexport const upstreamStatisticsHtmlGzip = ${JSON.stringify(upstreamStatisticsHtmlGzip)};\n`,
);
await writeFile(
  "shared/generated/ui-revision.ts",
  `export const uiRevision = ${JSON.stringify(revisionHash)};\nexport const pluginVersion = ${JSON.stringify(pkg.version)};\n`,
);
await writeFile(".tmp/web/index.html", html);
await writeFile(".tmp/web/statistics.html", statisticsHtml);
await writeFile(".tmp/web/metafile.json", JSON.stringify(result.metafile));
await writeFile(".tmp/web/metafile-statistics.json", JSON.stringify(statsResult.metafile));
await writeNotices(result.metafile);
console.log("Bundled the original upstream UI (with on-demand locales) and standalone Statistics bundle.");
