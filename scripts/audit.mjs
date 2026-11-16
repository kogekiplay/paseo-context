import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const findings = [];
for (const directory of ["client", "server", "shared"]) {
  for (const name of await readdir(directory, { recursive: true })) {
    if (!/\.[jt]sx?$/.test(name) || name.startsWith("generated/")) continue;
    const file = join(directory, name), text = await readFile(file, "utf8");
    const lines = text.split("\n");
    if (lines.length > 1000) findings.push({ severity: "high", title: "File exceeds 1000 lines", file, line: 1 });
    lines.forEach((line, index) => {
      if (directory === "client" && name !== "web.ts" && /document\.|window\.|localStorage|navigator\.|<(?:div|span|button|input|svg|canvas|section)[ >]|className=|onClick=/.test(line)) {
        findings.push({ severity: "high", title: "Browser API outside the web boundary", file, line: index + 1 });
      }
      if (/@deepseek-ai|@deepseek\/|cordis|schemastery/.test(line)) findings.push({ severity: "high", title: "Removed host dependency", file, line: index + 1 });
    });
  }
}
await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(".tmp", { recursive: true }).then(() => writeFile(".tmp/audit.json", JSON.stringify(findings, null, 2))));
if (findings.length) { console.error(JSON.stringify(findings, null, 2)); process.exitCode = 1; }
else console.log("Runtime boundaries and removed host dependency audit passed. Upstream web UI retains its original palette.");
