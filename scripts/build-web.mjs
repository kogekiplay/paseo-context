import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { writeNotices } from "./notices.mjs";
import { grammarPlugin } from "./grammars.mjs";
import { createHash } from "node:crypto";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const entry = resolve("src/client/styles/tailwind.css");
const compiler = await compile(await readFile(entry, "utf8"), { base: dirname(entry), onDependency() {} });
const scanner = new Scanner({ sources: compiler.sources });
await mkdir(".tmp/web", { recursive: true });
await writeFile(".tmp/web/tailwind.css", compiler.build(scanner.scan()));
const result = await build({
  entryPoints: ["web/main.tsx"], outfile: ".tmp/web/app.js", bundle: true, format: "iife", platform: "browser",
  target: ["chrome120", "safari17"], jsx: "automatic", minify: process.env.PASEO_CONTEXT_DEBUG !== "1", legalComments: "linked", metafile: true,
  define: { "process.env.NODE_ENV": '"production"', __PASEO_CONTEXT_VERSION__: JSON.stringify(pkg.version), __PASEO_CONTEXT_REPO__: JSON.stringify(pkg.homepage) },
  loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl", ".svg": "dataurl" },
  plugins: [await grammarPlugin(), {
    name: "modern-font-formats",
    setup(build) {
      build.onLoad({ filter: /katex\.min\.css$/ }, async ({ path }) => ({
        contents: (await readFile(path, "utf8")).replace(/,url\([^)]*\.(?:woff|ttf)\)\s*format\("[^"]+"\)/g, ""),
        loader: "css", resolveDir: dirname(path),
      }));
    },
  }],
});
const css = await readFile(".tmp/web/app.css", "utf8");
const js = await readFile(".tmp/web/app.js", "utf8");
const diagnostics = `const report=(message)=>{document.title="Paseo Context error: "+String(message);const data={type:"paseo-context:fatal",nonce:globalThis.__PASEO_CONTEXT_NONCE__,message:String(message)};if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(data));else parent.postMessage(data,"*")};addEventListener("error",e=>report(e.message));addEventListener("unhandledrejection",e=>report(e.reason?.message??e.reason));`;
const html = `<!doctype html><html data-platform="darwin"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-%%PASEO_CONTEXT_NONCE%%' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; connect-src 'none';"><style>${css.replaceAll("</style", "<\\/style")}</style></head><body><div id="root"></div><script nonce="%%PASEO_CONTEXT_NONCE%%">globalThis.__PASEO_CONTEXT_NONCE__="%%PASEO_CONTEXT_NONCE%%";${diagnostics}${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
await mkdir("shared/generated", { recursive: true });
await writeFile("shared/generated/upstream-ui.ts", `export const upstreamHtmlGzip = ${JSON.stringify(gzipSync(Buffer.from(html), { level: 9 }).toString("base64"))};\n`);
await writeFile("shared/generated/ui-revision.ts",
  `export const uiRevision = ${JSON.stringify(createHash("sha256").update(html).digest("hex"))};\nexport const pluginVersion = ${JSON.stringify(pkg.version)};\n`);
await writeFile(".tmp/web/index.html", html);
await writeFile(".tmp/web/metafile.json", JSON.stringify(result.metafile));
await writeNotices(result.metafile);
console.log("Bundled the original upstream UI, styles, primitives and isolated RPC bridge.");
