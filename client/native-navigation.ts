/** A loadDataWithBaseURL document has a real local origin on Android. */
export function nativeDocumentUrl(nonce: string) {
  return `https://paseo-context.invalid/${encodeURIComponent(nonce)}/`;
}

/** Only this frame's exact document and same-document history are allowed. */
export function isNativeDocumentUrl(url: string, baseUrl: string) {
  return url === "about:blank" || url.startsWith("about:blank#") || url === baseUrl || url.startsWith(`${baseUrl}#`);
}
