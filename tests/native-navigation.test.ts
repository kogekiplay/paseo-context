import { expect, test } from "vitest";
import { isNativeDocumentUrl, isNativeLoadEventUrl, nativeDocumentUrl } from "../client/native-navigation";

test("allows exactly the supplied native document and its local history, never arbitrary URLs on that origin", () => {
  const url = nativeDocumentUrl("one");
  for (const value of [url, `${url}#paseo-context=1:message`, "about:blank", "about:blank#paseo-context=1:message"]) {
    expect(isNativeDocumentUrl(value, url)).toBe(true);
  }
  for (const value of [nativeDocumentUrl("other"), `${url}file`, `${url}?redirect=1`, "https://paseo-context.invalid/",
    "https://paseo-context.invalid.evil/one/", "https://example.org", "data:text/html,<script>code</script>",
    "javascript:alert(1)", "file:///tmp/one"]) {
    expect(isNativeDocumentUrl(value, url)).toBe(false);
    expect(isNativeLoadEventUrl(value, url, true)).toBe(false);
  }
});

test("recognizes the empty Chromium document URL only as an Android load event", () => {
  const baseUrl = nativeDocumentUrl("one");
  const alias = "data:text/html;charset=utf-8;base64,";
  expect(isNativeLoadEventUrl(alias, baseUrl, true)).toBe(true);
  expect(isNativeLoadEventUrl(`${alias}#paseo-context=1:message`, baseUrl, true)).toBe(true);
  expect(isNativeLoadEventUrl(alias, baseUrl, false)).toBe(false);
  expect(isNativeDocumentUrl(alias, baseUrl)).toBe(false);
  expect(isNativeLoadEventUrl(alias + "AAAA", baseUrl, true)).toBe(false);
});
