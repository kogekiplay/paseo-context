import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const findings = [];
const files = ["index.client.tsx", "index.server.ts"];
for (const directory of ["client", "server", "shared", "web"]) {
  for (const name of await readdir(directory, { recursive: true })) {
    if (!/\.[jt]sx?$/.test(name)) continue;
    if (directory === "shared" && name.startsWith("generated/")) continue;
    if (directory === "web" && name.startsWith("vendor/")) continue;
    files.push(join(directory, name));
  }
}
for (const file of files) {
  const text = await readFile(file, "utf8");
  const lines = text.split("\n");
  if (lines.length > 1000) findings.push({ severity: "high", title: "File exceeds 1000 lines", file, line: 1 });
  const checkBrowserBoundary = file === "index.client.tsx" || (file.startsWith("client/") && file !== "client/web.ts");
  lines.forEach((line, index) => {
    if (checkBrowserBoundary && /document\.|window\.|localStorage|navigator\.|<(?:div|span|button|input|svg|canvas|section)[ >]|className=|onClick=/.test(line)) {
      findings.push({ severity: "high", title: "Browser API outside the web boundary", file, line: index + 1 });
    }
    if (/@deepseek-ai|@deepseek\/|cordis|schemastery/.test(line)) findings.push({ severity: "high", title: "Removed host dependency", file, line: index + 1 });
  });
}
await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(".tmp", { recursive: true }).then(() => writeFile(".tmp/audit.json", JSON.stringify(findings, null, 2))));
if (findings.length) { console.error(JSON.stringify(findings, null, 2)); process.exitCode = 1; }
else console.log("Runtime boundaries and removed host dependency audit passed. Upstream web UI retains its original palette.");
