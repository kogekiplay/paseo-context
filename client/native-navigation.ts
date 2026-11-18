/** A loadDataWithBaseURL document has a real local origin on Android. */
export function nativeDocumentUrl(nonce: string) {
  return `https://paseo-context.invalid/${encodeURIComponent(nonce)}/`;
}

/** Only this frame's exact document and same-document history are allowed. */
export function isNativeDocumentUrl(url: string, baseUrl: string) {
  return url === "about:blank" || url.startsWith("about:blank#") || url === baseUrl || url.startsWith(`${baseUrl}#`);
}

export function isNativeLoadEventUrl(url: string, baseUrl: string, android: boolean) {
  if (isNativeDocumentUrl(url, baseUrl)) return true;
  // Chromium stores loadDataWithBaseURL's HTML separately from this empty
  // navigation URL. Only recognize that alias in Android loading callbacks.
  return android && /^data:text\/html(?:;charset=utf-8)?;base64,(?:#|$)/i.test(url);
}
