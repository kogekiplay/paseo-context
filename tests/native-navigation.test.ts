import { expect, test } from "vitest";
import { isNativeDocumentUrl, nativeDocumentUrl } from "../client/native-navigation";

test("allows exactly the supplied native document and its local history, never arbitrary URLs on that origin", () => {
  const url = nativeDocumentUrl("one");
  for (const value of [url, `${url}#paseo-context=1:message`, "about:blank", "about:blank#paseo-context=1:message"]) {
    expect(isNativeDocumentUrl(value, url)).toBe(true);
  }
  for (const value of [nativeDocumentUrl("other"), `${url}file`, `${url}?redirect=1`, "https://paseo-context.invalid/",
    "https://paseo-context.invalid.evil/one/", "https://example.org", "data:text/html,<script>code</script>", "javascript:alert(1)", "file:///tmp/one"]) {
    expect(isNativeDocumentUrl(value, url)).toBe(false);
  }
});
