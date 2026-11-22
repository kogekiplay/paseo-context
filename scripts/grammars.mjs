import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

function mustReplace(source, pattern, replacement, label) {
  const next = source.replace(pattern, replacement);
  if (next === source) throw new Error(`Upstream grammar seam mismatch (${label}); update scripts/grammars.mjs.`);
  return next;
}

/** Keep the offline document small without discarding any supported grammar. */
export async function grammarPlugin() {
  const path = "web/vendor/ui/index.js";
  let source = await readFile(path, "utf8");
  const names = [...new Set([...source.matchAll(/(?:from |import\()"@shikijs\/langs\/([^"]+)"/g)].map((m) => m[1]))];
  if (names.length < 50) throw new Error("Upstream grammar imports changed; check the lazy grammar seam.");
  const compressed = {};
  for (const name of names) {
    const { default: grammar } = await import(`@shikijs/langs/${name}`);
    compressed[name] = gzipSync(JSON.stringify(grammar), { level: 9 }).toString("base64");
  }
  await writeFile("shared/generated/grammars.ts", `export const grammars: Record<string, string> = ${JSON.stringify(compressed)};\n`);
  source = mustReplace(source, /^import lang(?:Ts|Bash|Json) from "@shikijs\/langs\/[^"]+";\n/gm, "", "boot grammar imports");
  source = mustReplace(source, /const LANGS = \[[\s\S]*?\];/, "const LANGS = [];", "boot LANGS array");
  source = mustReplace(source, /const LAZY_GRAMMARS = new Map\(\[/, `const LAZY_GRAMMARS = new Map([
    ["typescript", () => loadGrammar("typescript")],
    ["shellscript", () => loadGrammar("shellscript")],
    ["json", () => loadGrammar("json")],`, "LAZY_GRAMMARS map");
  source = mustReplace(source, /import\("@shikijs\/langs\/([^"]+)"\)/g, 'loadGrammar("$1")', "dynamic grammar imports");
  // Empty boot grammars need no synchronous warmup. Highlighting initializes
  // only when a visible code surface asks for its language.
  source = mustReplace(source, /for \(const sample of BOOT_GRAMMAR_WARMUPS\)/, "for (const sample of [])", "BOOT_GRAMMAR_WARMUPS loop");
  source = mustReplace(source, /setTimeout\(\(\) => \{\s*highlighter\(\);\s*\}, 0\)\.unref\?\.\(\);/, "", "idle highlighter warmup");
  source = mustReplace(
    source,
    /(for \(const listener of listeners\) listener\(\);\n[ \t]*\}\));/,
    "$1.catch(() => { requested.delete(resolved); });",
    "grammar load failure recovery",
  );
  source = `import { loadGrammar } from "../../grammars";\n${source}`;
  return {
    name: "offline-lazy-grammars",
    setup(build) {
      build.onLoad({ filter: /web\/vendor\/ui\/index\.js$/ }, () => ({
        contents: source, loader: "js", resolveDir: resolve("web/vendor/ui"),
      }));
    },
  };
}
