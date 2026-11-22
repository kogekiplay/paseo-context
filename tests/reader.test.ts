import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionReader } from "../server/reader";
import { scopeSchema, type Agent } from "../shared/contracts";
import { ContextService } from "../server/service";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { UiRoutes } from "../server/ui-routes";

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paseo-context-test-")); fixtures.push(root);
  await mkdir(join(root, "sessions"));
  const file = join(root, "sessions", "rollout-fixture.jsonl");
  const agent: Agent = { id: "a", workspaceId: null, parentId: null, title: "Test", cwd: "/project", provider: "codex",
    model: "test", sessionId: "fixture", createdAt: 0, updatedAt: 0, archived: false, running: false };
  return { file, agent, reader: new SessionReader({ codex: root, claude: root }) };
}
const message = (value: string) => JSON.stringify({ type: "response_item", timestamp: "2026-11-16T01:00:00Z",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: value }] } });
describe("Incremental native reader", () => {
  test("renders overview and fleet while pricing is pending, then invalidates cached costs when prices arrive", async () => {
    const { reader, file, agent } = await fixture(), service = new ContextService(reader);
    const raw = { ...agent, labels: {}, status: "idle", persistence: { nativeHandle: "fixture" },
      createdAt: new Date(0).toISOString(), updatedAt: "2026-11-16T01:00:01Z" } as unknown as PaseoAgent;
    const paseo = { agents: { list: async () => ({ entries: [{ agent: raw }], pageInfo: { hasMore: false } }) } } as unknown as PaseoApi;
    service.pricing.refresh = () => new Promise(() => {});
    service.pricing.priceRequests = (_provider, requests) => requests.map((request) => ({ ...request,
      costUsd: service.pricing.revision ? 0.01 : null }));
    await writeFile(file, message("hello") + "\n" + JSON.stringify({ type: "token_usage_record", timestamp: "2026-11-16T01:00:01Z",
      payload: { response_id: "response", usage: { input_tokens: 100, output_tokens: 20 } } }) + "\n");
    try {
      const scope = scopeSchema.parse({ range: "all" });
      expect((await service.overview(scope, 0, paseo)).costUsd).toBeNull();
      expect((await service.fleet("a", paseo)).members).toHaveLength(1);
      service.pricing.revision++;
      expect((await service.overview(scope, 0, paseo)).costUsd).toBe(0.01);
    } finally { service.clear(); }
  });
  test("reuses unchanged derivations, but versions full-body rewrites, appends and metadata changes", async () => {
    const { reader, file, agent } = await fixture(), service = new ContextService(reader);
    const raw = { ...agent, labels: {}, status: "idle", persistence: { nativeHandle: "fixture" },
      createdAt: new Date(0).toISOString(), updatedAt: new Date(1000).toISOString() } as unknown as PaseoAgent;
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: raw }) }) } } as unknown as PaseoApi;
    service.pricing.refresh = async () => {};
    const routes = new UiRoutes(service);
    try {
      const prefix = "a".repeat(250);
      await writeFile(file, message(prefix + "before") + "\n");
      const first = await service.load(raw, paseo);
      expect(await service.load(raw, paseo)).toBe(first);
      const response: any = await routes.handle("bootstrap", { agentId: "a", mode: "statistics" }, paseo);
      await writeFile(file, message(prefix + "change") + "\n");
      const changed = new Date(Date.now() + 1000); await utimes(file, changed, changed);
      const rewritten: any = await routes.handle("bootstrap", { agentId: "a", mode: "statistics", revision: response.selected.revision }, paseo);
      expect(rewritten.selected.unchanged).toBeUndefined();
      expect(rewritten.selected.revision).toBeGreaterThan(first.revision);
      await appendFile(file, message("new item") + "\n");
      const appended = await service.load(raw, paseo);
      expect(appended.fold.nodes).toHaveLength(2);
      const renamed = await service.load({ ...raw, title: "Renamed" }, paseo);
      expect(renamed.summary.agent.title).toBe("Renamed");
      expect(renamed.revision).toBeGreaterThan(appended.revision);
    } finally { routes.clear(); service.clear(); }
  });
  test("reads UTF-8 body on demand and folds only complete appended records", async () => {
    const { reader, file, agent } = await fixture(), line = message("你好 🌏");
    await writeFile(file, line + "\n" + message("partial").slice(0, 40));
    const first = await reader.read(agent);
    expect(first?.entry.fold.nodes).toHaveLength(1);
    expect(await reader.content(agent, 0)).toBe("你好 🌏");
    await appendFile(file, message("partial").slice(40) + "\n");
    const second = await reader.read(agent);
    expect(second?.entry.fold.nodes).toHaveLength(2);
    expect(await reader.content(agent, 1)).toBe("partial");
    reader.clear();
  });
  test("resets state after truncation", async () => {
    const { reader, file, agent } = await fixture();
    await writeFile(file, message("long input".repeat(200)) + "\n");
    await reader.read(agent);
    await writeFile(file, message("new") + "\n");
    const result = await reader.read(agent);
    expect(result?.entry.fold.nodes).toHaveLength(1);
    expect(await reader.content(agent, 0)).toBe("new");
  });
  test("concurrent reads never apply appended records twice", async () => {
    const { reader, file, agent } = await fixture();
    await writeFile(file, message("first") + "\n");
    await reader.read(agent);
    await appendFile(file, message("second") + "\n");
    const results = await Promise.all(Array.from({ length: 8 }, () => reader.read(agent)));
    for (const result of results) expect(result?.entry.fold.nodes).toHaveLength(2);
  });
  test("invalidates same-length source rewrites and their cached text", async () => {
    const { reader, file, agent } = await fixture();
    await writeFile(file, message("before") + "\n");
    expect(await reader.content(agent, 0)).toBe("before");
    await writeFile(file, message("change") + "\n");
    const changed = new Date(Date.now() + 1000);
    await utimes(file, changed, changed);
    expect(await reader.content(agent, 0)).toBe("change");
    reader.clear();
  });
  test("resets the incremental fold when the same inode is rewritten and grows", async () => {
    const { reader, file, agent } = await fixture();
    try {
      await writeFile(file, message("before") + "\n");
      const first = (await reader.read(agent))!;
      await writeFile(file, message("change") + "\n" + message("appended") + "\n");
      const next = (await reader.read(agent))!;
      expect(next.entry.fold.epoch).not.toBe(first.entry.fold.epoch);
      expect(next.entry.fold.nodes.map((node) => node.preview)).toEqual(["change", "appended"]);
      await expect(first.bodies([0], (_id, body) => body)).rejects.toThrow(/changed/i);
      await expect(reader.content(agent, 0)).resolves.toBe("change");
    } finally { reader.clear(); }
  });
  test("rejects old content addresses after a rollout is atomically replaced", async () => {
    const { reader, file, agent } = await fixture();
    try {
      await writeFile(file, message("alpha") + "\n");
      const first = (await reader.read(agent))!;
      expect(await first.bodies([0], (_id, body) => body)).toEqual(new Map([[0, "alpha"]]));
      await writeFile(`${file}.next`, message("omega") + "\n");
      await rename(`${file}.next`, file);
      await expect(first.bodies([0], (_id, body) => body)).rejects.toThrow(/changed/i);
      await expect(reader.content(agent, 0)).resolves.toBe("omega");
    } finally { reader.clear(); }
  });
  test("checks a body record beyond the prefix and suffix append guards", async () => {
    const { reader, file, agent } = await fixture();
    try {
      const prefix = message("a".repeat(5000)), suffix = message("z".repeat(5000));
      await writeFile(file, `${prefix}\n${message("alpha")}\n${suffix}\n`);
      const first = (await reader.read(agent))!;
      await writeFile(file, `${prefix}\n${message("omega")}\n${suffix}\n${message("later")}\n`);
      await expect(first.bodies([1], (_id, body) => body)).rejects.toThrow(/changed/i);
      expect((await reader.read(agent))?.entry.fold.nodes[1].preview).toBe("omega");
    } finally { reader.clear(); }
  });
  test("reads a valid final JSON record without a newline only once when sealed", async () => {
    const { reader, file, agent } = await fixture();
    try {
      await writeFile(file, message("first") + "\n" + message("sealed tail"));
      expect((await reader.read(agent))?.entry.fold.nodes).toHaveLength(1);
      const sealed = { ...agent, archived: true };
      expect((await reader.read(sealed))?.entry.fold.nodes).toHaveLength(2);
      await expect(reader.content(sealed, 1)).resolves.toBe("sealed tail");
      await appendFile(file, "\n" + message("later") + "\n");
      expect((await reader.read(sealed))?.entry.fold.nodes.map((node) => node.preview)).toEqual(["first", "sealed tail", "later"]);
    } finally { reader.clear(); }
  });
  test("rejects path traversal and reports corrupted records", async () => {
    const { reader, file, agent } = await fixture();
    expect(await reader.locate({ ...agent, sessionId: "../outside" })).toBeNull();
    await writeFile(file, "{bad json}\n");
    await expect(reader.read(agent)).rejects.toThrow("invalid JSON");
  });
});
