import { gunzipSync } from "node:zlib";
import { upstreamHtmlGzip } from "../shared/generated/upstream-ui";

let document: string | undefined;
/** Static bundled UI only. Native clients do not need a DOM or a gzip decoder. */
export function uiDocument() {
  return document ??= gunzipSync(Buffer.from(upstreamHtmlGzip, "base64")).toString("utf8");
}
