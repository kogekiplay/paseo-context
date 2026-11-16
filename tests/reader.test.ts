import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionReader } from "../server/reader";
import type { Agent } from "../shared/contracts";

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
  test("rejects path traversal and reports corrupted records", async () => {
    const { reader, file, agent } = await fixture();
    expect(await reader.locate({ ...agent, sessionId: "../outside" })).toBeNull();
    await writeFile(file, "{bad json}\n");
    await expect(reader.read(agent)).rejects.toThrow("invalid JSON");
  });
});
