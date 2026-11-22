export const MAX_PUBLIC_JSON_BYTES = 8 * 1024 * 1024;

export async function readPublicJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  const limit = MAX_PUBLIC_JSON_BYTES;
  if (declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Public JSON exceeds the 8 MiB limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Public JSON response is empty");
  let bytes = Buffer.allocUnsafe(Number.isSafeInteger(declared) && declared > 0 ? declared : 0);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const end = length + value.byteLength;
      if (end > limit) {
        await reader.cancel().catch(() => {});
        throw new Error("Public JSON exceeds the 8 MiB limit");
      }
      if (end > bytes.length) {
        const next = Buffer.allocUnsafe(Math.min(limit, Math.max(end, 64 * 1024, bytes.length * 2)));
        bytes.copy(next, 0, 0, length);
        bytes = next;
      }
      bytes.set(value, length);
      length = end;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  } finally { reader.releaseLock(); }
}
