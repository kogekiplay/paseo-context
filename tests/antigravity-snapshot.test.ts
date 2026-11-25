import { copyFile, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import type * as Sqlite from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import type { Agent } from "../shared/contracts";
import { AntigravityDatabase } from "../server/antigravity-db";
import { SessionReader } from "../server/reader";
import { MIB, ReadBudget } from "../server/read-budget";

const ID = "247c9c90-1492-43b9-86ba-b49825487f4e";
const COPY = "84ec504d-1492-43b9-86ba-b49825487f4e";
const sqlite = process.getBuiltinModule?.("node:sqlite") as typeof Sqlite | undefined;
const sqliteTest = test.skipIf(!sqlite);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "paseo-agy-snapshot-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "conversations"), logs = join(root, "brain", ID, ".system_generated", "logs");
  await Promise.all([mkdir(directory), mkdir(logs, { recursive: true })]);
  const file = join(directory, `${ID}.db`), transcript = join(logs, "transcript_full.jsonl");
  const db = new sqlite!.DatabaseSync(file);
  cleanups.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)");
  return { root, directory, db, file, transcript };
}

sqliteTest("rejects torn, uninitialized, and checksum-invalid WalIndexHdr pairs without dropping usable SQLite facts", async () => {
  const { root, directory, db, file } = await fixture();
  db.exec("INSERT INTO steps VALUES (1, 14, X'')");
  const abort = new AbortController(), companion = new AntigravityDatabase(root, abort.signal);
  cleanups.push(() => { abort.abort(); companion.clear(); });
  const stable = (await companion.locate(ID))!;
  expect(stable.fingerprint).toBeTruthy();
  const trusted = await companion.read(stable, () => {});
  expect(trusted.fingerprint).toBe(stable.fingerprint);
  expect(await companion.read(stable, () => {})).toBe(trusted);

  const copy = join(directory, `${COPY}.db`);
  await Promise.all(["", "-wal", "-shm"].map((suffix) => copyFile(file + suffix, copy + suffix)));
  const shm = await open(`${copy}-shm`, "r+");
  try {
    const valid = Buffer.alloc(96);
    expect((await shm.read(valid, 0, 96, 0)).bytesRead).toBe(96);
    const torn = Buffer.from(valid);
    torn[48 + 8] ^= 1;
    const badChecksum = Buffer.from(valid);
    badChecksum[40] ^= 1;
    badChecksum[48 + 40] ^= 1;
    const uninitialized = Buffer.from(valid);
    uninitialized[12] = uninitialized[48 + 12] = 0;
    for (const invalid of [torn, badChecksum, uninitialized]) {
      await shm.write(invalid, 0, 96, 0);
      expect((await companion.locate(COPY))?.fingerprint).toBe("");
    }
    const little = endianness() === "LE";
    const next = Buffer.from(valid);
    const word = (offset: number) => little ? next.readUInt32LE(offset) : next.readUInt32BE(offset);
    const put = (value: number, offset: number) => little ? next.writeUInt32LE(value, offset) : next.writeUInt32BE(value, offset);
    put((word(8) + 1) >>> 0, 8);
    let first = 0, second = 0;
    for (let offset = 0; offset < 40; offset += 8) {
      first = (first + word(offset) + second) >>> 0;
      second = (second + word(offset + 4) + first) >>> 0;
    }
    put(first, 40);
    put(second, 44);
    next.copy(next, 48, 0, 48);
    await shm.write(next, 0, 96, 0);
    const updated = (await companion.locate(COPY))?.fingerprint;
    expect(updated).toBeTruthy();
    await shm.write(valid, 0, 96, 0);
    expect(updated).not.toBe((await companion.locate(COPY))?.fingerprint);
    await shm.write(badChecksum, 0, 96, 0);
  } finally { await shm.close(); }
  const transient = (await companion.locate(COPY))!;
  expect(transient.fingerprint).toBe("");
  const usable = await companion.read(transient, () => {});
  expect(usable.fingerprint).toBe("");
  expect(usable.contentKey).toBe(trusted.contentKey);
  expect(companion["cache"].peek(copy)).toBeUndefined();
});

sqliteTest("increases the queued budget for WAL growth and again when consumed metadata requires a replay", async () => {
  const { root, db, transcript } = await fixture();
  const input = `{"type":"PLANNER_RESPONSE","step_index":1,"content":"${"x".repeat(400 * 1024)}","output_tokens":9}\n`;
  await writeFile(transcript, input);
  db.exec("INSERT INTO steps VALUES (1, 15, X'4A024801')");
  const budget = new ReadBudget(4 * MIB, 2), reader = new SessionReader({ antigravity: root }, budget);
  cleanups.push(() => reader.clear());
  const agent = { id: "agent", sessionId: ID, provider: "antigravity", cwd: root } as Agent;
  const first = (await reader.read(agent))!;
  expect(first.entry.fold.summary(agent).usage.reasoning).toBe(1);
  const stale = (await reader.locateSource(agent))!;
  db.exec("CREATE TABLE growth (data BLOB); INSERT INTO growth VALUES (zeroblob(300000)); UPDATE steps SET metadata=X'4A024802' WHERE idx=1");
  const run = vi.spyOn(budget, "run");
  const result = (await reader.read(agent, stale))!;
  const queued = run.mock.calls.map(([bytes]) => bytes);
  expect(queued).toHaveLength(3);
  expect(queued[1]).toBeGreaterThan(queued[0]);
  expect(queued[2]).toBeGreaterThan(queued[1]);
  expect(queued[2]).toBe(budget.maxBytes);
  expect(result.companionFailed).toBeFalsy();
  expect(result.entry.fold.summary(agent).usage.reasoning).toBe(2);
  expect(result.entry.fold.epoch).not.toBe(first.entry.fold.epoch);
  expect(budget["used"]).toBe(0);
});
