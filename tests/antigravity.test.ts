import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { appendFile, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Sqlite from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { antigravityArgs, antigravityConversationId } from "../server/antigravity-log";
import { SessionReader } from "../server/reader";
import { agentOf, ContextService } from "../server/service";
import { UiRoutes } from "../server/ui-routes";
import { dayKeyOf } from "../shared/core/days";

const ID = "247c9c90-1492-43b9-86ba-b49825487f4e";
const model = "gemini-4-neon-high";
const wrapped = (conversationId: unknown = ID, version = 1) => `plugin:${JSON.stringify({ version, data: { conversationId } })}`;
const start = new Date(2026, 10, 22, 23, 59, 58, 500).getTime();
const iso = (at: number) => new Date(at).toISOString();
const row = (type: string, index: number, offset: number, data = {}) => ({
  type, step_index: index, created_at: iso(start + offset), ...data,
});
const user = (data = {}) => row("USER_INPUT", 0, -500, { source: "USER_EXPLICIT", content: "Hello 天", ...data });
const planner = (index: number, offset: number, data = {}) => row("PLANNER_RESPONSE", index, offset, {
  source: "MODEL", model, input_tokens: 120, cache_read_tokens: 80, output_tokens: 40, ...data,
});
const jsonl = (...rows: unknown[]) => rows.map((item) => JSON.stringify(item) + "\n").join("");
const result = (index: number, offset: number, content: string, data = {}) => row("GENERIC", index, offset, { content, ...data });
const toolOutput = (from: number, to: number, content: string) =>
  `Created At: ${iso(start + from)}\nCompleted At: ${iso(start + to)}\n${content}`;

let sqlite: typeof Sqlite | undefined;
try { sqlite = process.getBuiltinModule?.("node:sqlite") as typeof Sqlite | undefined; } catch {}
const sqliteTest = test.skipIf(!sqlite);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "paseo-context-agy-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const logs = join(root, "brain", ID, ".system_generated", "logs");
  const conversations = join(root, "conversations");
  await Promise.all([mkdir(logs, { recursive: true }), mkdir(conversations)]);
  const reader = new SessionReader({ antigravity: root });
  const raw = { id: "agy-agent", provider: "antigravity", model, title: "Antigravity fixture",
    cwd: root, persistence: { nativeHandle: wrapped() }, labels: {}, status: "idle",
    createdAt: iso(start - 500), updatedAt: iso(start + 10000) } as PaseoAgent;
  const agent = agentOf(raw);
  const refetch = vi.fn(async () => { throw new Error("Fixture native session used the Paseo timeline"); });
  const paseo = { agents: {
    ref: () => ({ refresh: async () => ({ agent: raw }), timeline: { refetch } }),
    list: async () => ({ entries: [{ agent: raw }], pageInfo: { hasMore: false } }),
  } } as unknown as PaseoApi;
  const service = new ContextService(reader);
  vi.spyOn(service.pricing, "refresh").mockResolvedValue();
  const routes = new UiRoutes(service);
  cleanups.push(() => { routes.clear(); service.clear(); });
  return { root, file: join(logs, "transcript_full.jsonl"), short: join(logs, "transcript.jsonl"),
    database: join(conversations, `${ID}.db`), reader, raw, agent, paseo, service, routes, refetch };
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  while (value >= 128) {
    bytes.push((value % 128) | 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function proto(fields: Record<number, number | string | Uint8Array>): Buffer {
  return Buffer.concat(Object.entries(fields).map(([tag, value]) => {
    const key = Number(tag) * 8;
    if (typeof value === "number") return Buffer.concat([varint(key), varint(value)]);
    const bytes = Buffer.from(value);
    return Buffer.concat([varint(key + 2), varint(bytes.length), bytes]);
  }));
}

function time(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return proto({ 1: seconds, 2: Math.round((ms - seconds * 1000) * 1e6) });
}

function databaseAt(path: string, generator = true) {
  const db = new sqlite!.DatabaseSync(path);
  cleanups.push(() => db.close());
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)");
  if (generator) db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
  return db;
}

function step(db: Sqlite.DatabaseSync, index: number, type: number, metadata: Buffer) {
  db.prepare("INSERT OR REPLACE INTO steps VALUES (?, ?, ?)").run(index, type, metadata);
}

function generation(db: Sqlite.DatabaseSync, index: number, step: number, usage: Buffer, ttft: number, decode: number) {
  db.prepare("INSERT OR REPLACE INTO gen_metadata VALUES (?, ?)").run(index,
    proto({ 1: proto({ 4: usage, 11: time(ttft), 12: time(decode) }), 2: varint(step) }));
}

sqliteTest("indexes a large database in step order while applying generator updates in row order", async () => {
  const { reader, database, agent } = await fixture();
  const db = databaseAt(database);
  db.exec(`WITH RECURSIVE source(idx) AS (VALUES (2) UNION ALL SELECT idx + 2 FROM source WHERE idx < 16384)
    INSERT INTO steps SELECT idx, 14, X'' FROM source`);
  step(db, 6, 15, proto({ 1: time(start), 8: time(start + 210), 9: proto({ 2: 50, 3: 20, 5: 40, 11: "original" }) }));
  step(db, 10, 909, Buffer.alloc(0));
  step(db, 12, 132, proto({ 32: time(start + 250), 8: time(start + 300) }));
  const largeIndex = 2 ** 32 + 11;
  generation(db, 30, 6, proto({ 3: 34, 9: 11 }), 35, 135);
  generation(db, 10, 6, proto({ 2: 130, 3: 30, 5: 61 }), 40, 90);
  generation(db, 2, largeIndex, proto({ 2: 100, 3: 5 }), 10, 11);
  generation(db, 3, 3, proto({ 2: 90, 3: 4 }), 20, 25);
  generation(db, 4, 10, proto({ 2: 1000, 3: 1 }), 10, 10);
  generation(db, 5, 12, proto({ 2: 1000, 3: 1 }), 10, 10);

  const source = (await reader.locateSource(agent))!.antigravity!.database!;
  const snapshot = await reader["paths"].antigravity.read(source, () => {});
  const ordered = [...snapshot.steps].map(([index]) => index);
  expect(snapshot.steps.size).toBe(8193);
  expect(ordered.slice(0, 7)).toEqual([2, 3, 4, 6, 8, 12, 14]);
  expect(ordered.at(-1)).toBe(largeIndex);
  expect(ordered.every((index, position) => position === 0 || index > ordered[position - 1])).toBe(true);
  expect(snapshot.steps.get(10)).toBeUndefined();
  expect(snapshot.steps.get(12)?.facts).toMatchObject({ type: "GENERIC", times: { start: start + 250, end: start + 300 } });
  expect(snapshot.steps.get(6)?.facts).toMatchObject({ type: "PLANNER_RESPONSE", responseId: "original", usageAt: start + 210,
    usage: { input: 130, cacheRead: 61, output: 34, reasoning: 11 }, timing: { start, ttftMs: 35, modelMs: 170 } });
  expect(snapshot.steps.get(3)?.facts).toMatchObject({ type: "PLANNER_RESPONSE", usage: { input: 90 }, timing: { ttftMs: 20 } });
  const updated = snapshot.steps.get(6)!;
  expect(updated.key).toBe(JSON.stringify(updated.facts));
});

sqliteTest("evicts companion database snapshots after idle time and releases their timers on clear", async () => {
  const { reader, database, agent } = await fixture();
  const db = databaseAt(database, false);
  step(db, 0, 14, proto({ 1: time(start) }));
  const companion = reader["paths"].antigravity;
  vi.useFakeTimers();
  try {
    const source = (await reader.locateSource(agent))!;
    await reader.read(agent, source);
    expect(companion["cache"].peek(database)).toBeDefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(companion["cache"].peek(database)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await reader.read(agent, source);
    reader.clear();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

test("resolves bare and versioned Antigravity UUIDs and rejects traversal and symlink escapes", async () => {
  const { agent, root, file, short, database, reader } = await fixture();
  expect(agent.sessionId).toBe(ID);
  for (const handle of [ID, ID.toUpperCase(), wrapped(), wrapped(ID.toUpperCase())]) {
    expect(antigravityConversationId(handle)).toBe(ID);
  }
  for (const handle of [null, "bad-id", `${ID}\n`, `../${ID}`, wrapped(`../../${ID}`), wrapped(ID, 2),
    wrapped({ id: ID }), `plugin:{"conversationId":"${ID}"}`, "plugin:{"]) {
    expect(antigravityConversationId(handle)).toBeNull();
    await expect(reader.read({ ...agent, sessionId: handle })).resolves.toBeNull();
  }
  const outside = join(root, "unrelated");
  await writeFile(outside, jsonl(user()));
  await symlink(outside, file);
  await symlink(outside, database);
  await expect(reader.locate(agent)).resolves.toBeNull();
  await writeFile(short, jsonl(user()));
  await expect(reader.locate({ ...agent, sessionId: wrapped() })).resolves.toBe(short);
});

test("reads the transcript incrementally and links shell, skill and file activity in FIFO order", async () => {
  const { agent, file, short, reader, routes, paseo } = await fixture();
  const calls = [
    { name: "run_command", args: { CommandLine: "git status", Cwd: "/project" } },
    { name: "read_file", args: { Path: "/project/skills/demo/SKILL.md", StartLine: 3, EndLine: 12 } },
    { name: "edit_file", args: JSON.stringify({ Path: "/project/a.ts", Target: "old\nolder", Replacement: "new" }) },
    { name: "write_file", args: { Path: "/project/b.ts", Content: "first\nsecond\n" } },
  ];
  const command = result(3, 1400, toolOutput(1400, 1900, "Process exited with code 0"));
  const tail = JSON.stringify(command);
  await writeFile(short, jsonl(user({ media: [{}, {}] }),
    row("SYSTEM_MESSAGE", 1, -400, { content: "Runtime constraints" }),
    planner(2, 0, { content: "Response", thinking: "Thinking aloud", tool_calls: calls })) + tail.slice(0, 40));
  const first = (await reader.read(agent))!;
  const fold = first.entry.fold, before = fold.summary(agent);
  expect(first.path).toBe(short);
  expect(before).toMatchObject({ turns: 1, steps: 1, images: 2, toolCalls: 4, contextTokens: 200,
    contextSource: "reported", usage: { input: 200, cacheRead: 80, output: 40, reasoning: 0 },
    usageSources: { input: "reported", cacheRead: "reported", output: "reported" } });
  expect(before.usageSources).not.toHaveProperty("reasoning");
  expect(before.usageSources).not.toHaveProperty("cacheWrite");
  expect(fold.toolResults.size).toBe(0);
  const skillBody = "---\nname: Demo Skill\n---\nFull skill body";
  await appendFile(short, tail.slice(40) + "\n" + jsonl(result(4, 1910, skillBody),
    result(5, 2000, "", { error: "No matching text", status: "ERROR" }), result(6, 2100, "Saved")));
  const second = (await reader.read(agent))!;
  expect(second.entry.fold).toBe(fold);
  expect([...fold.toolResults.keys()]).toEqual(calls.map((_call, index) => `agy:2:${index}`));
  expect(fold.commands[0]).toMatchObject({ command: "git status", cwd: "/project", programs: ["git"],
    status: "completed", exit: 0, duration: 500, time: start + 1400 });
  expect(fold.files).toMatchObject([
    { path: "/project/skills/demo/SKILL.md", kind: "read", error: false },
    { path: "/project/a.ts", kind: "write", added: 1, removed: 2, error: true },
    { path: "/project/b.ts", kind: "write", added: 2, removed: 0, error: false },
  ]);
  expect(fold.skills.get("Demo Skill")?.count).toBe(1);
  expect(fold.toolResults.get("agy:2:1")).not.toHaveProperty("toolDurationMs");
  const reasoning = fold.nodes.find((node) => node.category === "reasoning")!;
  const answer = fold.nodes.find((node) => node.category === "assistant")!;
  const skill = fold.nodes.find((node) => node.category === "skill")!;
  const read = fold.nodes.find((node) => node.callId === "agy:2:1" && node.category === "calls")!;
  const bodies = await second.bodies([reasoning.id, answer.id, skill.id, read.id], (_id, body) => body);
  expect(bodies.get(reasoning.id)).toBe("Thinking aloud");
  expect(bodies.get(answer.id)).toBe("Response");
  expect(bodies.get(skill.id)).toBe(skillBody);
  expect(antigravityArgs(bodies.get(read.id))).toMatchObject({ Path: "/project/skills/demo/SKILL.md",
    file_path: "/project/skills/demo/SKILL.md", offset: 3, limit: 12, StartLine: 3, EndLine: 12 });
  await expect(routes.handle("history.page", { address: { sessionId: agent.id }, throughSeq: skill.seq }, paseo))
    .resolves.toMatchObject({ records: [
      { event: { type: "tool/call", data: { callId: "agy:2:1", name: "read_file" } } },
      { event: { type: "tool/result", data: { message: { content: [{ type: "text", text: skillBody }] } } } },
    ] });
  await expect(routes.handle("statistics.details", { agentId: agent.id, requestId: "agy:2" }, paseo))
    .resolves.toMatchObject({ calls: expect.arrayContaining([
      expect.objectContaining({ callId: "agy:2:2", before: "old\nolder", after: "new" }),
    ]) });
  expect(fold.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "inject", title: "System message" })]));
  await expect(first.bodies([answer.id], (_id, body) => body)).rejects.toThrow(/changed/i);

  await appendFile(short, jsonl(row("CHECKPOINT", 7, 3000, {
    content: "Compacted history", input_tokens: 200, cache_read_tokens: 50, output_tokens: 20,
  }), row("ERROR_MESSAGE", 8, 4000, { error: "Provider stopped" })));
  const compacted = (await reader.read(agent))!.entry.fold;
  expect(compacted.summary(agent)).toMatchObject({ turns: 1, steps: 2, contextTokens: null,
    usage: { input: 450, cacheRead: 130, output: 60 }, toolMs: 500 });
  expect(compacted.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "compaction" })]));
  expect(compacted.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ category: "inject", preview: "Compacted history" }),
    expect.objectContaining({ category: "inject", preview: "Provider stopped", error: true }),
  ]));
  expect(compacted.nodes[0].goneSeq).toBeDefined();

  await writeFile(file, jsonl(user()) + JSON.stringify(planner(1, 0, { content: "Sealed final answer" })));
  const full = (await reader.read({ ...agent, archived: true }))!;
  expect(full.path).toBe(file);
  expect(full.entry.fold.epoch).not.toBe(fold.epoch);
  expect(full.entry.fold.summary(agent)).toMatchObject({ steps: 1, toolCalls: 0 });
  await expect(reader.content({ ...agent, archived: true }, 1)).resolves.toBe("Sealed final answer");
});

sqliteTest("uses exact provider timing and usage on Context, Statistics and Overview routes", async () => {
  const { file, database, raw, service, routes, paseo, refetch } = await fixture();
  raw.lastUsage = { contextWindowUsedTokens: 999_000, contextWindowMaxTokens: 512_000 } as PaseoAgent["lastUsage"];
  const db = databaseAt(database);
  const used = proto({ 2: 120, 3: 40, 4: 30, 5: 80, 9: 14, 11: "r-one" });
  step(db, 0, 14, proto({ 1: time(start - 500) }));
  step(db, 1, 15, proto({ 1: time(start), 6: time(start + 630), 7: time(start + 3025),
    8: time(start + 3100), 9: used }));
  step(db, 2, 132, proto({ 32: time(start + 3200), 8: time(start + 4290), 4: proto({ 2: "run_command" }) }));
  generation(db, 11, 1, used, 625, 2400);
  await writeFile(file, jsonl(user(), planner(1, -200, { content: "Provider answer", thinking: "Reasoning",
    tool_calls: [{ name: "run_command", args: { CommandLine: "git diff" } }] }),
  result(2, 3100, toolOutput(3000, 9000, "Captured command output"))));

  const data = await service.load(raw, paseo);
  expect(data.summary).toMatchObject({ source: "native", turns: 1, steps: 1, humanInputs: 1, contextTokens: 230,
    contextSource: "reported", contextWindow: 512_000, usage: { input: 230, output: 40, cacheWrite: 30, reasoning: 14 },
    modelMs: 3025, ttftMs: 625, toolMs: 1090, wallMs: 4115, costUsd: null });
  expect(data.requests[0]).toMatchObject({ id: "agy:1", time: start, usageAt: start + 3100,
    providerTiming: { start, end: start + 3025, ttftMs: 625, modelMs: 3025 } });
  const selected = await routes.handle("bootstrap", { agentId: raw.id, mode: "context" }, paseo);
  expect(selected).toMatchObject({ selected: { head: {
    paseoComplete: true, provider: "antigravity", counts: { turns: 1, steps: 1 }, answers: 1,
    generatedReasoning: 14, generatedAnswerTokens: 26, last: { prompt: 230, contextSource: "reported" },
    cost: { antigravity: { [model]: { off: { uncached: 120, cacheRead: 80, cacheWrite: 30, output: 40 } } } },
    timing: { ttftMs: 625, genMs: 2400, toolsMs: 1090, toolBusyMs: 1090 },
  } } });
  await expect(routes.rpc("detail", { agentId: raw.id }, paseo)).resolves.toMatchObject({ ok: true, value: {
    requests: [{ prompt: 230, cacheRead: 80, output: 40, activeMs: 3025 }],
    commands: [{ tool: "bash", start: start + 3200, end: start + 4290 }],
  } });
  const stats = await routes.handle("bootstrap", { agentId: raw.id, mode: "statistics" }, paseo) as {
    selected: { statistics: { turns: Array<{ steps: Array<{ sourceId: string }> }>; stepCount: number } };
  };
  expect(stats.selected.statistics).toMatchObject({ stepCount: 1, turns: [{ steps: [{
    context: 230, output: 40, cacheRead: 80, cacheWrite: 30, cacheHit: 80 / 230, timingSource: undefined,
    ttft: 625, model: 3025, decode: 2400, tool: 1090, toolWall: 1090, startTime: start, endTime: start + 4290,
    usageSources: { input: "reported", reasoning: "reported", cacheWrite: "reported" },
    calls: [{ callId: "agy:1:0", name: "run_command", ms: 1090, startedAt: start + 3200, endedAt: start + 4290 }],
  }] }] });
  const requestId = stats.selected.statistics.turns[0].steps[0].sourceId;
  await expect(routes.handle("statistics.details", { agentId: raw.id, requestId }, paseo)).resolves.toMatchObject({
    answerBody: "Provider answer", calls: [{ text: expect.stringContaining("Captured command output") }],
  });
  const overview = (day: string) => routes.handle("overview", { part: "summary", scope: { range: "all", day } }, paseo);
  await expect(overview(dayKeyOf(start)!)).resolves.toMatchObject({ value: { summary: { tokens: 0, turns: 0 } } });
  await expect(overview(dayKeyOf(start + 3100)!)).resolves.toMatchObject({ value: { summary: {
    tokens: 270, turns: 1, cacheHit: "34.8", coverage: { complete: true, covered: 1 },
    windowTiming: { calls: 1, toolCalls: 1, toolsMs: 1090, wallMs: 2615 },
  } } });
  vi.mocked(service.pricing.refresh).mockRestore();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    google: { models: { [model]: { cost: { input: 2, cache_read: 0.5, cache_write: 1, output: 5 } } } },
  })));
  await service.pricing.refresh();
  expect((await service.load(raw, paseo)).summary).toMatchObject({ costUsd: 510 / 1e6, costComplete: true });
  expect(refetch).not.toHaveBeenCalled();
});

sqliteTest("falls back to step metadata and deduplicates a repeated provider response", async () => {
  const { file, database, reader, agent } = await fixture();
  const db = databaseAt(database, false);
  const initial = proto({ 2: 120, 3: 40, 4: 10, 5: 80, 9: 16, 11: "same-response" });
  step(db, 1, 15, proto({ 1: time(start), 6: time(start + 300), 7: time(start + 1100), 9: initial }));
  step(db, 2, 15, proto({ 9: proto({ 3: 44, 11: "same-response" }) }));
  await writeFile(file, jsonl(user(), planner(1, 0, { content: "Original answer" }),
    row("PLANNER_RESPONSE", 2, 1200, { model })));
  const fold = (await reader.read(agent))!.entry.fold;
  expect(fold.requests).toHaveLength(1);
  expect(fold.requests[0]).toMatchObject({ id: "agy:1", usage: { input: 210, output: 44, reasoning: 16 },
    providerTiming: { ttftMs: 300, modelMs: 1100, start, end: start + 1100 } });
  expect(fold.summary(agent)).toMatchObject({ steps: 1, ttftMs: 300, modelMs: 1100, timedOutputTokens: 44 });
});

sqliteTest("refreshes consumed WAL metadata and preserves the transcript fold for new steps", async () => {
  const { raw, file, database, service, paseo, agent } = await fixture();
  const db = databaseAt(database);
  const usage = (input: number) => proto({ 2: input, 3: 40, 5: 80, 11: "r-one" });
  generation(db, 1, 1, usage(120), 300, 700);
  await writeFile(file, jsonl(user(), planner(1, 0, { content: "One" })));
  const initial = await service.load(raw, paseo);
  const created = await stat(database, { bigint: true });
  expect((await service.summary(raw, paseo)).usage.input).toBe(200);
  generation(db, 1, 1, usage(140), 450, 800);
  expect((await stat(database, { bigint: true })).mtimeNs).toBe(created.mtimeNs);
  expect((await service.summary(raw, paseo)).usage.input).toBe(220);
  const corrected = await service.load(raw, paseo);
  expect(corrected.revision).toBeGreaterThan(initial.revision);
  expect(corrected.summary).toMatchObject({ ttftMs: 450, modelMs: 1250 });
  await expect(initial.bodies!([1], (_id, body) => body)).rejects.toThrow(/changed/i);
  await expect(service.reader.content(agent, 1)).resolves.toBe("One");

  generation(db, 2, 2, proto({ 2: 200, 3: 20, 11: "r-two" }), 600, 400);
  const future = await service.load(raw, paseo);
  expect(future).toBe(corrected);
  await appendFile(file, jsonl(planner(2, 2000, { cache_read_tokens: 0, content: "Two" })));
  const appended = await service.load(raw, paseo);
  expect(appended.fold).toBe(corrected.fold);
  expect(appended.summary).toMatchObject({ steps: 2, contextTokens: 200, modelMs: 2250, ttftMs: 1050 });
});

sqliteTest("serves SQLite-only metrics and keeps request and tool bodies absent", async () => {
  const { database, service, raw, paseo, refetch, routes } = await fixture();
  const db = databaseAt(database, false);
  step(db, 0, 14, proto({ 1: time(start - 500) }));
  step(db, 1, 15, proto({ 1: time(start), 6: time(start + 100), 7: time(start + 500),
    9: proto({ 2: 80, 3: 12, 4: 6, 5: 30, 9: 5, 11: "native-db" }) }));
  step(db, 2, 132, proto({ 32: time(start + 500), 8: time(start + 1700), 4: proto({ 2: "read_file" }) }));
  const data = await service.load(raw, paseo);
  expect(data.summary).toMatchObject({ source: "native", turns: 1, steps: 1, humanInputs: 1, toolCalls: 1,
    contextTokens: 116, usage: { input: 116, output: 12, cacheRead: 30, cacheWrite: 6, reasoning: 5 },
    modelMs: 500, ttftMs: 100, toolMs: 1200 });
  expect(data.summary.notices).toContain("native-metadata-only");
  expect(Object.values(data.summary.parts).every((value) => value === 0)).toBe(true);
  expect(data.fold.nodes.every((node) => node.preview === "" && node.textLength === 0)).toBe(true);
  expect(data.fold.nodes.some((node) => node.category === "assistant" || node.category === "user")).toBe(false);
  await expect(routes.handle("statistics.details", { agentId: raw.id, requestId: data.requests[0].id }, paseo)).resolves.toMatchObject({
    answerBody: null, calls: [{ callId: "agy:1:0", args: null, text: null, chars: null, lines: null }],
  });
  expect(refetch).not.toHaveBeenCalled();
});

test("reports unknown timing without the database and uses Paseo context only when native input is unavailable", async () => {
  const { file, database, service, raw, paseo, routes } = await fixture();
  raw.lastUsage = { contextWindowUsedTokens: 321 } as PaseoAgent["lastUsage"];
  await writeFile(database, "Unreadable SQLite contents");
  await writeFile(file, jsonl(user(), row("PLANNER_RESPONSE", 1, 0, {
    model, output_tokens: 25, thinking: "Unmetered reasoning", tool_calls: [{ name: "read_file", args: { Path: "/project/a.ts" } }],
  }), result(2, 300, "Contents with no reported end time")));
  if (sqlite) expect((await service.load(raw, paseo)).companionFailed).toBe(true);
  const builtin = process.getBuiltinModule?.bind(process);
  if (builtin) vi.spyOn(process, "getBuiltinModule").mockImplementation((name) => name === "node:sqlite" ? undefined : builtin(name));
  expect((await service.load(raw, paseo)).summary).toMatchObject({ source: "native", contextTokens: 321,
    contextSource: "paseo", usageSources: { output: "reported" }, costUsd: null });
  await expect(routes.handle("bootstrap", { agentId: raw.id, mode: "statistics" }, paseo)).resolves.toMatchObject({
    selected: { statistics: { turns: [{ steps: [{
      context: null, output: 25, cacheRead: null, cacheWrite: null, cacheHit: null, tool: null,
      model: null, ttft: null, decode: null, calls: [{ ms: null, startedAt: null, endedAt: null }],
    }] }] } },
  });
});

sqliteTest("resets partial tool queues across planner/checkpoint, handles 100%-cached proto3 steps, and drops inverted timestamps", async () => {
  const { file, database, service, raw, paseo, routes } = await fixture();
  const db = databaseAt(database);
  // Step 1: 100% cache hit in proto3 (tag 2 input omitted as 0, tag 5 cacheRead = 80000, tag 3 output = 150)
  // and inverted planner end < start (start - 100) + inverted tool end < start.
  step(db, 0, 14, proto({ 1: time(start - 500) }));
  step(db, 1, 15, proto({ 1: time(start), 7: time(start - 100), 9: proto({ 2: 120, 3: 150, 4: 30, 5: 80, 11: "r-cached" }) }));
  generation(db, 1, 1, proto({ 3: 150, 5: 80000, 11: "r-cached" }), 200, 300);
  step(db, 2, 132, proto({ 32: time(start + 1000), 8: time(start + 900), 4: proto({ 2: "read_file" }) }));
  step(db, 4, 15, proto({ 1: time(start + 2000), 7: time(start + 2500), 9: proto({ 2: 50, 3: 20, 5: 100, 11: "r-next" }) }));
  step(db, 5, 132, proto({ 32: time(start + 2600), 8: time(start + 2900), 4: proto({ 2: "run_command" }) }));
  await writeFile(file, jsonl(
    user(),
    // Two tool calls emitted, but only one GENERIC result arrives before the next planner response.
    planner(1, 0, {
      input_tokens: 120, cache_read_tokens: 80, output_tokens: 150,
      tool_calls: [{ name: "read_file", args: { Path: "/project/one.ts" } }, { name: "read_file", args: { Path: "/project/two.ts" } }],
    }),
    result(2, 1000, "Partial batch result"),
    planner(4, 2000, {
      input_tokens: 50, cache_read_tokens: 100, output_tokens: 20,
      tool_calls: [{ name: "run_command", args: { CommandLine: "echo ok" } }],
    }),
    result(5, 2900, "ok\nProcess exited with code 0"),
  ));
  const data = await service.load(raw, paseo);
  // Step 1 uses gen_metadata 100% cache hit (80000) without inheriting stale 120 input / 30 cacheWrite.
  expect(data.requests[0].usage).toMatchObject({ input: 80000, cacheRead: 80000, cacheWrite: 0, output: 150 });
  expect(data.requests[0].usageSources).toMatchObject({ input: "reported", cacheRead: "reported", output: "reported" });
  expect(data.requests[0].usageSources?.cacheWrite).toBeUndefined();
  // Step 5 pairs with agy:4:0 (run_command), NOT the stale unconsumed agy:1:1!
  expect(data.fold.toolResults.get("agy:4:0")?.tool).toBe("run_command");
  expect(data.fold.toolResults.has("agy:1:1")).toBe(false);
  // Inverted timestamps must not yield negative toolWall or 0ms wall.
  const stats = await routes.handle("bootstrap", { agentId: raw.id, mode: "statistics" }, paseo) as any;
  const stepOne = stats.selected.statistics.turns[0].steps[0];
  expect(stepOne.toolWall).toBeNull();
  expect(stepOne.calls[0].endedAt).toBeNull();
  expect(stepOne.model).toBe(500);
  // Cost usage stays populated for the session despite the 100% cache hit step.
  const ctx = await routes.handle("bootstrap", { agentId: raw.id, mode: "context" }, paseo) as any;
  expect(ctx.selected.head.cost?.antigravity?.[model]?.off).toMatchObject({ uncached: 50, cacheRead: 80100, output: 170 });
});
