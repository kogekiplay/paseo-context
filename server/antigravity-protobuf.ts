type Value = number | Uint8Array;

class ProtobufReader {
  private offset = 0;

  constructor(private bytes: Uint8Array) {}

  get done() { return this.offset === this.bytes.length; }

  varint(): number {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      const byte = this.bytes[this.offset++];
      if (byte === undefined || shift === 63 && byte > 1) break;
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error("Invalid Antigravity metadata varint");
  }

  take(length: number): Uint8Array {
    const start = this.offset;
    if (!Number.isSafeInteger(length) || length > this.bytes.length - start) {
      throw new Error("Truncated Antigravity metadata field");
    }
    this.offset += length;
    return this.bytes.subarray(start, this.offset);
  }
}

function* fields(bytes: Uint8Array): Iterable<[number, Value]> {
  const reader = new ProtobufReader(bytes);
  while (!reader.done) {
    const key = reader.varint(), tag = Math.floor(key / 8);
    if (tag < 1 || tag > 0x1fffffff) throw new Error("Invalid Antigravity metadata tag");
    switch (key % 8) {
      case 0: yield [tag, reader.varint()]; break;
      case 2: yield [tag, reader.take(reader.varint())]; break;
      case 1: reader.take(8); break;
      case 5: reader.take(4); break;
      default: throw new Error("Unsupported Antigravity metadata field");
    }
  }
}

export function protobuf(value: unknown): ReadonlyMap<number, Value> {
  if (value instanceof Uint8Array) {
    try {
      const result = new Map<number, Value>();
      // Keep the first occurrence. Generator step indices are repeated.
      for (const [tag, item] of fields(value)) if (!result.has(tag)) result.set(tag, item);
      return result;
    } catch {
      // A malformed blob must not discard the other steps in the snapshot.
    }
  }
  return new Map();
}

export function firstIndex(value: Value | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (!value?.length) return undefined;
  try { return new ProtobufReader(value).varint(); } catch { return undefined; }
}

export function milliseconds(value: Value | undefined): number | undefined {
  if (!(value instanceof Uint8Array)) return undefined;
  const fields = protobuf(value);
  if (value.length && !fields.has(1) && !fields.has(2)) return undefined;
  const seconds = fields.get(1) ?? 0, nanos = fields.get(2) ?? 0;
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds > 8.64e12
    || typeof nanos !== "number" || nanos >= 1e9) return undefined;
  return seconds * 1000 + nanos / 1e6;
}

const decoder = new TextDecoder();
export function protobufText(value: Value | undefined): string | undefined {
  return value instanceof Uint8Array && value.length <= 512 ? decoder.decode(value) || undefined : undefined;
}
