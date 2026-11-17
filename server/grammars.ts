import { gunzipSync } from "node:zlib";
import { grammars } from "../shared/generated/grammars";

/** Fixed build-time allowlist; only data crosses the existing nonce-bound bridge. */
export function grammarOf(name: string): unknown {
  if (!Object.hasOwn(grammars, name)) throw new Error("Unsupported syntax language");
  return JSON.parse(gunzipSync(Buffer.from(grammars[name], "base64")).toString("utf8"));
}
