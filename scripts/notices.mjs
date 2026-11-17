import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeNotices(metafile) {
  const names = [...new Set(["@shikijs/langs", ...Object.keys(metafile.inputs).flatMap((path) => {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path);
    return match ? [match[1]] : [];
  })])].sort();
  const sections = [
    "# Third-party notices",
    "Paseo Context derives from bowenliang123/dsh-context under Apache-2.0. Its LICENSE and NOTICE are included in this distribution.",
    "## Static DeepSeek UI modules",
    "UI primitives, theme, store, code-language and workspace-path modules were extracted from the corresponding @deepseek-ai/dsh-* packages, version 0.2.0-rc.2. They are bundled static libraries and do not connect to a DSH host.",
    await readFile("web/vendor/LICENSE", "utf8"),
    "## Original Statistics table",
    "The static Statistics view, stylesheet, eight translations and pure metric aggregation derive from DeepSeek's MIT client-ui-stats at commit 39163dd30f703a79079e2d2446545cff3c453738 (package 0.2.2-rc.3). Host registrations and runtime integrations are excluded; Paseo supplies the captured-data adapter.",
    await readFile("web/vendor/statistics/LICENSE", "utf8"),
    "## React Native WebView",
    "Native adapters use Paseo's already bundled react-native-webview 13.16.1 component. Its package is not loaded as a second runtime. Native source contracts informed this adapter.",
    await readFile("web/vendor/WEBVIEW_LICENSE", "utf8"),
  ];
  for (const name of names) {
    const directory = join("node_modules", name);
    const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    let license = "";
    for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md", "license.txt", "LICENCE", "LICENCE.md", "COPYING"]) {
      try { license = await readFile(join(directory, file), "utf8"); break; } catch {}
    }
    if (!license) throw new Error(`Missing bundled license text for ${name}`);
    sections.push(`## ${pkg.name} ${pkg.version}\n\n${license.trim()}`);
  }
  await writeFile("THIRD_PARTY_NOTICES.md", sections.join("\n\n") + "\n");
}
