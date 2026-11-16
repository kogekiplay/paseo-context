import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await Promise.all([
  build({ entryPoints: ["index.client.tsx"], outfile: "dist/index.client.js", bundle: true,
    format: "esm", platform: "browser", target: "es2022", packages: "external", jsx: "automatic" }),
  build({ entryPoints: ["index.server.ts"], outfile: "dist/index.server.js", bundle: true,
    format: "esm", platform: "node", target: "node22", packages: "external" }),
]);
console.log("Both Paseo runtime entries compiled successfully.");
