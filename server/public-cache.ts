import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { record } from "./value";

const maxBytes = 8 * 1024 * 1024;
const maxAge = 30 * 86_400_000;

export class PublicCache {
  private closed = false;
  private pending = new Set<Promise<void>>();
  constructor(private root = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "paseo-context")) {}

  async read(name: "pricing" | "recommendations") {
    const file = join(this.root, `${name}-v1.json`);
    try {
      if ((await stat(file)).size > maxBytes) return null;
      const { at, value } = record(JSON.parse(await readFile(file, "utf8")));
      if (typeof at !== "number" || !Number.isFinite(at) || at > Date.now() || Date.now() - at >= maxAge) return null;
      return { at, value };
    } catch { return null; }
  }

  async write(name: "pricing" | "recommendations", value: unknown, at: number) {
    if (this.closed) return;
    const pending = this.publish(name, value, at);
    this.pending.add(pending);
    try { await pending; } finally { this.pending.delete(pending); }
  }

  private async publish(name: "pricing" | "recommendations", value: unknown, at: number) {
    const file = join(this.root, `${name}-v1.json`), temporary = `${file}.${randomUUID()}.tmp`;
    const data = JSON.stringify({ at, value });
    if (Buffer.byteLength(data) > maxBytes) return;
    try {
      await mkdir(this.root, { recursive: true });
      await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
      const previous = await this.read(name);
      if (!this.closed && (!previous || previous.at <= at)) await rename(temporary, file);
    } catch {} finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async clear() {
    this.closed = true;
    await Promise.allSettled(this.pending);
  }
}
