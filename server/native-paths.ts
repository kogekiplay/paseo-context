import { ensureActive } from "./paging";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { Agent } from "../shared/contracts";
import { antigravityConversationId } from "./antigravity-log";
import { AntigravityDatabase, type AntigravityDatabaseFile } from "./antigravity-db";

const DIRECTORY_TTL_MS = 4_000;
const PATH_LIMIT = 512;
const INDEX_MAX_CHARS = 4 * 1024 * 1024;
const SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const ROLLOUT_DATE = /^(?:rollout-)\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2}-/;

export interface NativeRoots { codex?: string; claude?: string; antigravity?: string }
export interface NativeLocation {
  path: string;
  sealed: boolean;
  antigravity?: { database: AntigravityDatabaseFile | null; databaseOnly: boolean };
}

async function contents(path: string, recursive = false) {
  try { return await readdir(path, { recursive }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function isFile(path: string) {
  try { return (await stat(path)).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function antigravityTranscript(root: string, id: string) {
  try {
    const brain = await realpath(join(root, "brain"));
    const directory = join(brain, id, ".system_generated", "logs");
    for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
      const path = join(directory, name);
      if (await isFile(path) && await realpath(path) === path) return path;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return null;
}

interface Directory {
  locations: NativeLocation[];
  byId: Map<string, NativeLocation>;
  error?: unknown;
}

export class NativePaths {
  private cached = new Map<string, NativeLocation>();
  private codexIndex?: { at: number; directory: Directory };
  private indexing?: Promise<Directory>;

  private roots: Required<NativeRoots>;
  readonly antigravity: AntigravityDatabase;

  constructor(roots: NativeRoots, private signal: AbortSignal) {
    this.roots = {
      codex: roots.codex ?? (process.env.CODEX_HOME || join(homedir(), ".codex")),
      claude: roots.claude ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")),
      antigravity: roots.antigravity ?? (process.env.ANTIGRAVITY_HOME || join(homedir(), ".gemini", "antigravity-cli")),
    };
    this.antigravity = new AntigravityDatabase(this.roots.antigravity, signal);
  }

  private async codexDirectory() {
    if (this.codexIndex && Date.now() - this.codexIndex.at < DIRECTORY_TTL_MS) return this.codexIndex.directory;
    this.codexIndex = undefined;
    if (this.indexing) return this.indexing;
    const pending = this.indexing = this.indexCodex();
    try { return await pending; }
    finally { if (this.indexing === pending) this.indexing = undefined; }
  }

  private async indexCodex(): Promise<Directory> {
    const folders = ["sessions", "archived_sessions"];
    const lists = await Promise.allSettled(folders.map((folder) => contents(join(this.roots.codex, folder), true)));
    ensureActive(this.signal);
    const directory: Directory = { locations: [], byId: new Map() };
    let chars = 0;
    for (const [index, result] of lists.entries()) {
      if (result.status === "rejected") { directory.error ??= result.reason; continue; }
      for (const file of result.value) {
        if (!file.endsWith(".jsonl")) continue;
        const path = join(this.roots.codex, folders[index], file);
        const location = { path, sealed: index === 1 };
        const stem = basename(file, ".jsonl");
        const id = ROLLOUT_DATE.test(stem) ? stem.replace(ROLLOUT_DATE, "") : stem.replace(/^rollout-/, "");
        directory.locations.push(location);
        for (const key of [stem, id]) if (!directory.byId.has(key)) directory.byId.set(key, location);
        chars += path.length + stem.length + id.length + 128;
      }
    }
    if (chars <= INDEX_MAX_CHARS) this.codexIndex = { at: Date.now(), directory };
    return directory;
  }

  private codexLocation(directory: Directory, id: string) {
    const location = directory.byId.get(id) ?? directory.locations.find(({ path }) => basename(path).endsWith(`-${id}.jsonl`));
    if (!location && directory.error) throw directory.error;
    return location;
  }

  private remember(key: string, location: NativeLocation) {
    this.cached.delete(key);
    this.cached.set(key, location);
    if (this.cached.size > PATH_LIMIT) this.cached.delete(this.cached.keys().next().value!);
  }

  async locate(agent: Agent, directory?: Directory): Promise<NativeLocation | null> {
    ensureActive(this.signal);
    const { provider, sessionId, cwd } = agent;
    if (provider === "antigravity") {
      const id = antigravityConversationId(sessionId);
      if (!id) return null;
      const [log, db] = await Promise.allSettled([
        antigravityTranscript(this.roots.antigravity, id), this.antigravity.locate(id),
      ]);
      ensureActive(this.signal);
      if (log.status === "rejected") throw log.reason;
      const transcript = log.value;
      if (db.status === "rejected" && !transcript) throw db.reason;
      const database = db.status === "fulfilled" ? db.value : null;
      if (transcript) return { path: transcript, sealed: false, antigravity: { database, databaseOnly: false } };
      return database ? { path: database.path, sealed: false, antigravity: { database, databaseOnly: true } } : null;
    }
    if (!sessionId || !SESSION_ID.test(sessionId)) return null;
    const key = `${provider}:${sessionId}`;
    const hit = this.cached.get(key);
    if (hit && await isFile(hit.path)) {
      ensureActive(this.signal);
      this.remember(key, hit);
      return hit;
    }
    if (hit) {
      this.cached.delete(key);
      if (provider === "codex") this.codexIndex = undefined;
    }
    let location: NativeLocation | undefined;
    if (provider === "codex") {
      location = this.codexLocation(directory ?? await this.codexDirectory(), sessionId);
      if (location && !await isFile(location.path)) {
        // A rollout can move into the archive between discovery and lookup.
        this.codexIndex = undefined;
        location = this.codexLocation(await this.codexDirectory(), sessionId);
      }
    } else if (provider === "claude") {
      const root = join(this.roots.claude, "projects");
      const direct = isAbsolute(cwd) ? join(root, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`) : null;
      if (direct && await isFile(direct)) location = { path: direct, sealed: false };
      if (!location) for (const project of await contents(root)) {
        ensureActive(this.signal);
        const candidate = join(root, project, `${sessionId}.jsonl`);
        if (await isFile(candidate)) { location = { path: candidate, sealed: false }; break; }
      }
    }
    ensureActive(this.signal);
    if (location) this.remember(key, location);
    return location ?? null;
  }

  // Scope the index to a scan as well. Very large directories can still be
  // indexed once for that scan without pinning their listing between scans.
  async forAgents(agents: readonly Agent[]) {
    const directory = agents.some(({ provider, sessionId }) => provider === "codex" && sessionId && SESSION_ID.test(sessionId))
      ? await this.codexDirectory()
      : undefined;
    return (agent: Agent) => this.locate(agent, directory);
  }

  clear() {
    this.cached.clear();
    this.codexIndex = undefined;
    this.indexing = undefined;
    this.antigravity.clear();
  }
}
