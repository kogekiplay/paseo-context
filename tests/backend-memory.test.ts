import { execFileSync } from "node:child_process";
import { URL } from "node:url";
import { expect, test, vi } from "vitest";
import { ContextFold } from "../server/fold";
import { ReadBudget } from "../server/read-budget";
import { detachPreview, detachSlice } from "../server/value";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("retains short independent previews while accounting for the full native text", () => {
  expect(detachSlice("a\ud800b", 2)).toBe("a\ud800");
  expect(detachPreview("端末\n\t preview long", 10)).toBe("端末 preview");
  expect(detachPreview(`name${" ".repeat(10_000)}body`, 8)).toBe("name ");
  expect(detachPreview("a\u00a0\u1680\u200a\u2028\u2029\u202f\u205f\u3000\ufeffb\u0085\ud800", 24)).toBe("a b\u0085\ud800");
  execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { ContextFold } from "./server/fold.ts";
    const fold = new ContextFold("codex");
    const add = (text) => fold.apply({ type: "response_item", payload: {
      type: "message", role: "user", content: [{ text }],
    } });
    add("warmup");
    const mib = 1024 * 1024;
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let index = 0; index < 23; index++) add(Buffer.alloc(mib, 65 + index).toString());
    function addLargeWithWhitespace() {
      const bytes = Buffer.alloc(8 * mib, 88);
      bytes[1] = 32;
      bytes[2] = 9;
      add(bytes.toString());
    }
    addLargeWithWhitespace();
    global.gc(); global.gc();
    const growth = process.memoryUsage().heapUsed - before;
    assert.equal(fold.nodes.length, 25);
    assert.equal(fold.nodes.at(-1).preview, "X " + "X".repeat(178));
    assert.equal(fold.nodes.at(-1).textLength, 8 * mib);
    assert.equal(fold.nodes.at(-1).tokens, 8 * mib / 4 + 4);
    assert.ok(growth < 4 * mib, "Retained heap grew by " + growth + " bytes");
  `], { cwd: new URL("..", import.meta.url), timeout: 10_000 });
});

test("derived sessions become collectible when the source reader evicts their snapshot", () => {
  execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { setImmediate } from "node:timers/promises";
    import { SessionReader } from "./server/reader.ts";
    import { ContextService, agentOf } from "./server/service.ts";
    const root = await mkdtemp(join(tmpdir(), "paseo-context-retention-"));
    const reader = new SessionReader({ codex: root });
    const service = new ContextService(reader);
    try {
      const dir = join(root, "sessions");
      await mkdir(dir);
      const raw = (index) => ({ id: String(index), title: "Fixture", cwd: root, provider: "codex", labels: {},
        status: "idle", persistence: { nativeHandle: "fixture-" + index } });
      const row = { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "Fixture body" }] } };
      for (let index = 0; index < 9; index++) await writeFile(join(dir, "rollout-fixture-" + index + ".jsonl"), JSON.stringify(row) + "\\n");
      const weak = new WeakRef(await service.load(raw(0), {}));
      for (let index = 1; index < 9; index++) await reader.read(agentOf(raw(index)));
      for (let attempt = 0; attempt < 3; attempt++) { await setImmediate(); global.gc(); }
      assert.equal(weak.deref(), undefined);
    } finally { service.clear(); await rm(root, { recursive: true, force: true }); }
  `], { cwd: new URL("..", import.meta.url), timeout: 10_000 });
});

test("estimates command characters, content hashes and the response and tool indexes", () => {
  const sample = (length: number) => {
    const fold = new ContextFold("codex");
    fold.apply({ type: "response_item", timestamp: 1000, payload: {
      type: "function_call", name: "exec_command", call_id: "call", arguments: { command: `echo ${"a".repeat(length)}` },
    } });
    fold.apply({ type: "response_item", timestamp: 1220, payload: { type: "function_call_output", call_id: "call", output: "done" } });
    fold.apply({ type: "token_usage_record", timestamp: 1300, payload: { response_id: "response", usage: { input_tokens: 10, output_tokens: 3 } } });
    return fold;
  };
  const short = sample(10), long = sample(4000);
  expect(long.commands[0].command).toHaveLength(2000);
  expect(long.residentBytes - short.residentBytes).toBeGreaterThanOrEqual(2 * (2000 - short.commands[0].command.length));
  expect(long.contentHashes).toHaveLength(2);
  expect(long.residentBytes).toBeGreaterThan(long.meter.residentBytes + long.statistics.residentBytes + 4000 + 2 * 128);
  expect(long.toolResults.get("call")?.toolDurationMs).toBe(220);
});

test("shares byte and concurrency reservations, aborts waiters, and runs a large source alone", async () => {
  const budget = new ReadBudget(100, 2);
  const alive = new AbortController(), stopped = new AbortController();
  const gate = deferred(), done = deferred();
  const active = vi.fn(async (account: (bytes: number) => void) => { account(75); await gate.promise; });
  const canceled = vi.fn(async () => {}), small = vi.fn(async () => { await done.promise; });
  const oversized = vi.fn(async () => "complete");
  const first = budget.run(50, alive.signal, active);
  await Promise.resolve();
  const waiting = budget.run(30, stopped.signal, canceled);
  const rejected = expect(waiting).rejects.toThrow(/stopped/);
  const second = budget.run(10, alive.signal, small);
  const third = budget.run(1000, alive.signal, oversized);
  await Promise.resolve();
  expect(active).toHaveBeenCalledOnce();
  expect(canceled).not.toHaveBeenCalled();
  expect(small).not.toHaveBeenCalled();
  stopped.abort();
  await rejected;
  expect(small).toHaveBeenCalledOnce();
  gate.resolve();
  await first;
  expect(oversized).not.toHaveBeenCalled();
  done.resolve();
  await second;
  await expect(third).resolves.toBe("complete");
  expect(canceled).not.toHaveBeenCalled();

  const capGate = deferred(), capStarted = vi.fn(async () => { await capGate.promise; });
  const reads = [1, 2, 3].map(() => budget.run(1, alive.signal, capStarted));
  await Promise.resolve();
  expect(capStarted).toHaveBeenCalledTimes(2);
  capGate.resolve();
  await Promise.all(reads);
  expect(capStarted).toHaveBeenCalledTimes(3);
});

test("uses an exclusive reservation for a non-finite byte estimate and releases it afterwards", async () => {
  const budget = new ReadBudget(100, 2), { signal } = new AbortController();
  const gate = deferred(), small = vi.fn(async () => "read");
  const first = budget.run(20, signal, async (account) => { account(NaN); await gate.promise; });
  await Promise.resolve();
  const second = budget.run(1, signal, small);
  await Promise.resolve();
  expect(small).not.toHaveBeenCalled();
  gate.resolve();
  await first;
  await expect(second).resolves.toBe("read");
});
