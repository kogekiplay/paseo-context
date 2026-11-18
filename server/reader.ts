import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Agent } from "../shared/contracts";
import { ContextFold } from "./fold";
import { messagesOf } from "./normalize";

interface Entry {
  fold: ContextFold; offset: number; ino: number; tail: string; tailOffset: number;
  decoder: StringDecoder; locations: Array<{ offset: number; length: number }>;
  touched: number; busy: Promise<Entry> | null;
  version: number; mtimeMs: number;
}
export class SessionReader {
  private cache = new Map<string, Entry>();
  private paths = new Map<string, { path: string; at: number }>();
  private bodies = new Map<string, { text: string; at: number }>();
  private version = 0;
  private lifetime = new AbortController();
  private bodyTimer: ReturnType<typeof setInterval> | null = null;
  constructor(private roots = {
    codex: process.env.CODEX_HOME || join(homedir(), ".codex"),
    claude: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  }) {}
  private async exists(path: string) {
    try { return (await stat(path)).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async locate(agent: Agent): Promise<string | null> {
    const { provider, sessionId, cwd } = agent;
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
    const key = `${provider}:${sessionId}`;
    const hit = this.paths.get(key);
    if (hit && await this.exists(hit.path)) return hit.path;
    let path: string | null = null;
    if (provider === "codex") {
      for (const folder of ["sessions", "archived_sessions"]) {
        const root = join(this.roots.codex, folder);
        let files: string[];
        try { files = await readdir(root, { recursive: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        const file = files.find((f) => f.endsWith(`-${sessionId}.jsonl`) || f === `${sessionId}.jsonl`);
        if (file) { path = join(root, file); break; }
      }
    } else if (provider === "claude") {
      const root = join(this.roots.claude, "projects");
      if (isAbsolute(cwd)) {
        const direct = join(root, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
        if (await this.exists(direct)) path = direct;
      }
      if (!path) {
        let projects: string[];
        try { projects = await readdir(root); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; projects = []; }
        for (const project of projects) {
          const candidate = join(root, project, `${sessionId}.jsonl`);
          if (await this.exists(candidate)) { path = candidate; break; }
        }
      }
    }
    if (path && !this.lifetime.signal.aborted) {
      if (this.paths.size >= 512) this.paths.delete(this.paths.keys().next().value!);
      this.paths.set(key, { path, at: Date.now() });
    }
    return path;
  }
  async read(agent: Agent) {
    const path = await this.locate(agent);
    const signal = this.lifetime.signal;
    if (signal.aborted) throw new Error("Plugin was stopped");
    if (!path) return null;
    let entry = this.cache.get(path);
    if (entry?.busy) return { path, entry: await entry.busy };
    const info = await stat(path);
    if (signal.aborted) throw new Error("Plugin was stopped");
    entry = this.cache.get(path);
    if (entry?.busy) return { path, entry: await entry.busy };
    if (!entry || entry.ino !== info.ino || info.size < entry.offset || (info.size === entry.offset && info.mtimeMs !== entry.mtimeMs)) {
      entry = { fold: new ContextFold(agent.provider), offset: 0, ino: info.ino, tail: "", tailOffset: 0,
        decoder: new StringDecoder("utf8"), locations: [], touched: Date.now(), busy: null, version: ++this.version, mtimeMs: info.mtimeMs };
      this.cache.set(path, entry);
    }
    entry.touched = Date.now();
    for (const [key, value] of this.cache) {
      if (key !== path && !value.busy && (this.cache.size > 8 || Date.now() - value.touched > 120_000)) this.cache.delete(key);
    }
    const current = entry;
    current.busy = (async () => {
      if (info.size > current.offset) {
        const stream = createReadStream(path, { start: current.offset, end: info.size - 1, signal });
        for await (const buffer of stream) {
          const decoded = current.tail + current.decoder.write(buffer);
          const lines = decoded.split("\n");
          current.tail = lines.pop() ?? "";
          for (const line of lines) {
            const length = Buffer.byteLength(line, "utf8") + 1;
            current.locations.push({ offset: current.tailOffset, length: length - 1 });
            current.tailOffset += length;
            if (!line.trim()) { current.fold.apply({}); continue; }
            try { current.fold.apply(JSON.parse(line)); }
            catch { throw new Error("Session log contains an invalid JSON record"); }
          }
        }
        current.offset = info.size;
      }
      current.mtimeMs = info.mtimeMs;
      return current;
    })();
    try { return { path, entry: await current.busy }; }
    catch (error) { this.cache.delete(path); throw error; }
    finally { current.busy = null; }
  }
  async content(agent: Agent, nodeId: number): Promise<string> {
    const data = await this.read(agent), node = data?.entry.fold.nodes[nodeId];
    if (!data || !node) throw new Error("Context item is no longer available");
    const location = data.entry.locations[node.line - 1];
    if (!location) throw new Error("Context source record is no longer available");
    const key = `${data.path}:${data.entry.version}:${node.line}:${node.block}`;
    const cached = this.bodies.get(key);
    if (cached) {
      this.bodies.delete(key); cached.at = Date.now(); this.bodies.set(key, cached);
      return cached.text;
    }
    const file = await open(data.path, "r");
    try {
      const bytes = Buffer.alloc(location.length);
      await file.read(bytes, 0, bytes.length, location.offset);
      const messages = messagesOf(JSON.parse(bytes.toString("utf8")), agent.provider);
      const message = messages.find((m) => m.block === node.block && (m.category === node.category || node.category === "skill"));
      const text = message?.text ?? "";
      if (!this.lifetime.signal.aborted && text.length <= 32 * 1024 * 1024) {
        let chars = [...this.bodies.values()].reduce((n, body) => n + body.text.length, text.length);
        for (const [oldKey, body] of this.bodies) {
          if (chars <= 32 * 1024 * 1024 && this.bodies.size < 4) break;
          this.bodies.delete(oldKey); chars -= body.text.length;
        }
        this.bodies.set(key, { text, at: Date.now() });
        if (!this.bodyTimer) {
          this.bodyTimer = setInterval(() => {
            for (const [key, body] of this.bodies) if (Date.now() - body.at > 30000) this.bodies.delete(key);
          }, 30000);
          this.bodyTimer.unref();
        }
      }
      return text;
    } finally { await file.close(); }
  }
  clear() {
    this.lifetime.abort();
    this.cache.clear(); this.paths.clear(); this.bodies.clear();
    if (this.bodyTimer) clearInterval(this.bodyTimer); this.bodyTimer = null;
  }
}
