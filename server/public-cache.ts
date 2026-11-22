import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { record } from "./value";
import { MAX_PUBLIC_JSON_BYTES as maxBytes } from "./bounded-json";

const maxAge = 30 * 86_400_000;
type CacheName = "pricing" | "recommendations";
const writes = new Map<string, Promise<void>>();

function isFresh(at: unknown): at is number {
  const now = Date.now();
  return typeof at === "number" && Number.isFinite(at) && at <= now && now - at < maxAge;
}

export class PublicCache {
  private closed = false;
  private pending = new Set<Promise<void>>();
  constructor(private root = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "paseo-context")) {}

  private async versions(name: CacheName) {
    const pattern = new RegExp(`^${name}-v2\\.(\\d+)\\.[a-f0-9-]+\\.json$`);
    const names = await readdir(this.root).catch(() => []);
    return names.flatMap((file) => {
      const match = pattern.exec(file);
      return match ? [{ file, at: Number(match[1]) }] : [];
    }).sort((a, b) => b.at - a.at || b.file.localeCompare(a.file));
  }

  private async readFile(name: string, expected?: number) {
    try {
      const file = await open(join(this.root, name), "r");
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > maxBytes) return null;
        const bytes = Buffer.allocUnsafe(info.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== info.size) return null;
        const { at, value } = record(JSON.parse(bytes.toString("utf8", 0, offset)));
        return isFresh(at) && (expected === undefined || at === expected) ? { at, value } : null;
      } finally { await file.close(); }
    } catch { return null; }
  }

  async read(name: CacheName) {
    for (const entry of await this.versions(name)) {
      if (!isFresh(entry.at)) continue;
      const value = await this.readFile(entry.file, entry.at);
      if (value) return value;
    }
    return this.readFile(`${name}-v1.json`);
  }

  async write(name: CacheName, value: unknown, at: number) {
    if (this.closed || !Number.isSafeInteger(at) || !isFresh(at)) return;
    const key = resolve(this.root, name);
    const previous = writes.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.publish(name, value, at));
    writes.set(key, pending);
    this.pending.add(pending);
    try { await pending; }
    finally {
      this.pending.delete(pending);
      if (writes.get(key) === pending) writes.delete(key);
    }
  }

  private async publish(name: CacheName, value: unknown, at: number) {
    if (this.closed) return;
    const file = `${name}-v2.${at}.${randomUUID()}.json`, target = join(this.root, file), temporary = `${target}.tmp`;
    try {
      const data = JSON.stringify({ at, value });
      if (Buffer.byteLength(data) > maxBytes) return;
      const previous = await this.read(name);
      if (this.closed || previous && previous.at > at) return;
      await mkdir(this.root, { recursive: true });
      await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      if (this.closed) return;
      // Separate names let independent daemon processes publish atomically.
      // A writer can prune only versions ordered below its own.
      await rename(temporary, target);
      for (const entry of await this.versions(name)) {
        if (entry.at < at || entry.at === at && entry.file.localeCompare(file) < 0) {
          await rm(join(this.root, entry.file), { force: true }).catch(() => {});
        }
      }
    } catch {} finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async clear() {
    this.closed = true;
    await Promise.allSettled(this.pending);
  }
}
