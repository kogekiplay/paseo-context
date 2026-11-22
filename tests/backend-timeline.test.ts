import { expect, test, vi } from "vitest";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { ContextFold } from "../server/fold";
import { ContextService, listAgents } from "../server/service";
import { statisticsOf } from "../server/statistics";
import { UiRoutes } from "../server/ui-routes";
import { UiFleet } from "../server/ui-fleet";
import { scopeSchema } from "../shared/contracts";
import { ReadBudget } from "../server/read-budget";
import { SessionReader } from "../server/reader";

const at = (millis: number) => new Date(millis).toISOString();
const raw = (id: string, extra = {}) => ({ id, title: id, provider: "antigravity", cwd: "/fixture", status: "idle",
  labels: {}, createdAt: at(1000), updatedAt: at(9000), ...extra }) as PaseoAgent;
const cursor = (seq: number, epoch = "history") => ({ epoch, seq });
const entry = (seq: number, item: unknown, timestamp = at(seq * 1000), seqEnd = seq) => ({ seqStart: seq, seqEnd, item, timestamp });
const page = (entries: ReturnType<typeof entry>[], extra = {}) => ({ entries, epoch: "history", hasOlder: false, hasNewer: false, ...extra });
const inScope = scopeSchema.parse({ range: "all" });

function serviceOf(reader?: ContextService["reader"]) {
  const service = new ContextService(reader ?? { locate: async () => null, read: async () => null,
    content: async () => { throw new Error("native data is unavailable"); }, clear() {} });
  service.pricing.refresh = async () => {};
  return service;
}

function apiOf(agents: PaseoAgent[], refetch: (id: string, options: any) => Promise<unknown>) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return { agents: {
    list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false } }),
    ref: (id: string) => ({ refresh: async () => ({ agent: byId.get(id) }), timeline: { refetch: (options: any) => refetch(id, options) } }),
  } } as unknown as PaseoApi;
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

test("expires inactive timeline frames and still resolves bodies held by active readers", async () => {
  vi.useFakeTimers();
  const agent = raw("timeline"), service = serviceOf();
  const refetch = vi.fn(async () => page([entry(1, { type: "user_message", text: "old snapshot" })], { endCursor: cursor(1) }));
  const paseo = apiOf([agent], refetch);
  try {
    const first = await service.load(agent, paseo);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
    const next = await service.load(agent, paseo);
    expect(next.fold).not.toBe(first.fold);
    expect(next.revision).toBe(first.revision);
    expect(refetch.mock.calls.map(([, options]: any[]) => options.direction)).toEqual(["tail", "tail"]);
    expect(await service.contents(first, [0])).toEqual(new Map([[0, "old snapshot"]]));
  } finally { service.clear(); vi.useRealTimers(); }
});

test("shares admission between timeline and corpus RPCs and cancels both queued reads on teardown", async () => {
  const budget = new ReadBudget(1024, 1), signal = new AbortController(), barrier = deferred<void>();
  const pending = budget.run(1024, signal.signal, () => barrier.promise);
  const budgetRun = vi.spyOn(budget, "run");
  const agent = raw("timeline"), service = serviceOf(new SessionReader({}, budget));
  const refetch = vi.fn(async () => page([])), paseo = apiOf([agent], refetch);
  const directory = vi.spyOn(paseo.agents, "list");
  try {
    const timeline = expect(service.load(agent, paseo)).rejects.toThrow(/stopped/);
    const corpus = expect(service.backfill(paseo)).rejects.toThrow(/stopped/);
    await vi.waitFor(() => expect(budgetRun).toHaveBeenCalledTimes(2));
    expect(refetch).not.toHaveBeenCalled();
    expect(directory).not.toHaveBeenCalled();
    service.clear();
    await Promise.all([timeline, corpus]);
    expect(refetch).not.toHaveBeenCalled();
    expect(directory).not.toHaveBeenCalled();
  } finally { service.clear(); barrier.resolve(); await pending; }
});

test("increments a complete timeline with its epoch cursor and batches Statistics bodies without a history reread", async () => {
  const agent = raw("antigravity"), service = serviceOf(), routes = new UiRoutes(service);
  const captured = [entry(1, { type: "user_message", text: "Use a skill" }),
    entry(2, { type: "tool_call", callId: "skill", name: "read", status: "completed",
      detail: { type: "read", filePath: "/skills/review/SKILL.md", content: "# Captured instructions" } })];
  const tail = [entry(3, { type: "tool_call", callId: "fetch", name: "fetch", status: "completed",
    detail: { type: "fetch", url: "https://example.test/", result: "captured fetch result", durationMs: 250 } })];
  const refetch = vi.fn()
    .mockResolvedValueOnce(page(tail, { hasOlder: true, startCursor: cursor(3), endCursor: cursor(3) }))
    .mockResolvedValueOnce(page(captured, { startCursor: cursor(1), endCursor: cursor(2) }))
    .mockResolvedValueOnce(page([entry(4, { type: "assistant_message", text: "Done" })], { endCursor: cursor(4) }))
    .mockResolvedValueOnce(page([], { endCursor: cursor(4) }));
  const paseo = apiOf([agent], refetch);
  try {
    const first = await service.load(agent, paseo);
    expect(first.fold.nodes.filter((node) => node.category === "assistant")).toHaveLength(0);
    const updated = await service.load(agent, paseo);
    const step = statisticsOf(updated).turns[0].steps[0];
    expect(step.calls.map(({ name, ms }) => ({ name, ms }))).toEqual([{ name: "read", ms: null }, { name: "fetch", ms: 250 }]);
    expect(step).toMatchObject({ tool: 250, toolWall: null, toolPending: 0 });
    const details = await routes.rpc("statistics.details", { agentId: agent.id, requestId: step.sourceId }, paseo) as any;
    expect(details).toMatchObject({ contentRevision: step.contentRevision, answerBody: "Done", calls: [
      { callId: "skill", text: "# Captured instructions" }, { callId: "fetch", text: "captured fetch result" },
    ] });
    expect(refetch.mock.calls.map(([, options]) => [options.direction, options.cursor?.seq])).toEqual([
      ["tail", undefined], ["before", 3], ["after", 3], ["after", 4],
    ]);
  } finally { routes.clear(); service.clear(); }
});

test("rebuilds a changed projected row and resets after epoch replacement", async () => {
  const agent = raw("projected"), service = serviceOf();
  const reply = (text: string) => ({ type: "assistant_message", text });
  const refetch = vi.fn()
    .mockResolvedValueOnce(page([entry(1, reply("partial"))], { endCursor: cursor(1) }))
    .mockResolvedValueOnce(page([entry(1, reply("full"), at(1000), 2)], { endCursor: cursor(2) }))
    .mockResolvedValueOnce(page([], { epoch: "replacement", reset: true }))
    .mockResolvedValueOnce(page([entry(1, reply("replaced"))], { epoch: "replacement", endCursor: cursor(1, "replacement") }));
  const paseo = apiOf([agent], refetch);
  try {
    const first = await service.load(agent, paseo), second = await service.load(agent, paseo);
    expect(second.fold.nodes.map((node) => node.preview)).toEqual(["full"]);
    expect(second.revision).toBeGreaterThan(first.revision);
    const third = await service.load(agent, paseo);
    expect(third.fold.epoch).toBe("replacement");
    expect(third.fold.nodes.map((node) => node.preview)).toEqual(["replaced"]);
    expect(refetch.mock.calls.map(([, options]) => options.direction)).toEqual(["tail", "after", "after", "tail"]);
  } finally { service.clear(); }
});

test("never treats missing timeline or directory cursors as a completed read", async () => {
  const agent = raw("partial"), service = serviceOf();
  const paseos = apiOf([agent], async () => page([], { hasOlder: true }));
  try {
    await expect(service.load(agent, paseos)).rejects.toThrow(/omitted its history cursor/);
    await expect(service.backfill(paseos)).resolves.toMatchObject({ complete: false, covered: 0, failed: 1 });
    const directory = { agents: { list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: true } }) } } as unknown as PaseoApi;
    await expect(listAgents(directory)).rejects.toThrow(/omitted its history cursor/);
  } finally { service.clear(); }
});

test("reports unreadable coverage and reuses every unchanged ledger beyond the hot summary cache", async () => {
  const agents = Array.from({ length: 600 }, (_, index) => raw(`agent-${index}`)), service = serviceOf();
  const refetch = vi.fn(async (id: string) => {
    if (id === "agent-599") throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    return page([]);
  });
  const paseo = apiOf(agents, refetch);
  try {
    await expect(service.backfill(paseo)).resolves.toMatchObject({ complete: false, covered: 599, unreadable: 1, failed: 0 });
    expect(refetch).toHaveBeenCalledTimes(600);
    const overview = await service.overviewForScreen(inScope, 0, paseo, "");
    expect(overview.coverage).toMatchObject({ complete: false, covered: 599, unreadable: 1, failed: 0 });
    await expect(service.backfill(paseo)).resolves.toMatchObject({ complete: false, covered: 599, unreadable: 1 });
    expect(refetch).toHaveBeenCalledTimes(601);
  } finally { service.clear(); }
});

test("canonicalizes a shared native session without dropping its root or descendants", async () => {
  const provider = "codex";
  const root = raw("root", { provider, persistence: { nativeHandle: "same" } });
  const alias = raw("alias", { provider, persistence: { nativeHandle: "same" }, labels: { "paseo.parent-agent-id": "root" } });
  const leaf = raw("leaf", { provider, persistence: { nativeHandle: "leaf-session" }, labels: { "paseo.parent-agent-id": "alias" } });
  const service = serviceOf(), fleet = new UiFleet(service);
  const refetch = vi.fn(async (_id: string) => page([]));
  const paseo = apiOf([alias, leaf, root], refetch);
  try {
    const family = await fleet.read(root.id, paseo, undefined, false);
    expect(family).toMatchObject({ rootId: "root", total: 2, failed: 0 });
    expect(family.aliases?.get("alias")).toBe("root");
    expect(family.agents.map(({ id, parentId }) => [id, parentId])).toEqual([["root", null], ["leaf", "root"]]);
    expect((await fleet.summary(family, paseo)).rootId).toBe("root");
    expect(fleet.rows(family, alias.id).map(({ id, parentId }) => [id, parentId])).toEqual([["alias", undefined], ["leaf", "alias"]]);
    expect((await fleet.summary(family, paseo, alias.id)).rootId).toBe("alias");
    expect(refetch.mock.calls.map(([id]) => id)).toEqual(["root", "leaf"]);
  } finally { fleet.clear(); service.clear(); }
});

test("stops Fleet and session directory paging after clear, including an RPC already in flight", async () => {
  for (const read of [(service: ContextService, api: PaseoApi) => service.fleet("root", api),
    (service: ContextService, api: PaseoApi) => service.directory(api)]) {
    const waiting = deferred<unknown>(), called = deferred<AbortSignal>();
    const service = serviceOf();
    const list = vi.fn(({ signal }) => { called.resolve(signal); return waiting.promise; });
    const api = { agents: { list } } as unknown as PaseoApi;
    const result = read(service, api);
    const signal = await called.promise;
    expect(signal.aborted).toBe(false);
    service.clear();
    expect(signal.aborted).toBe(true);
    waiting.resolve({ entries: [], pageInfo: { hasMore: true, nextCursor: "next" } });
    await expect(result).rejects.toThrow(/stopped/i);
    expect(list).toHaveBeenCalledTimes(1);
  }
});

test("sends each detail collection once while retaining headline and system fields for the existing decoder", async () => {
  const agent = raw("native", { provider: "codex" }), fold = new ContextFold("codex");
  fold.apply({ type: "session_meta", timestamp: at(1000), payload: { base_instructions: "Fixture system" } });
  fold.apply({ type: "response_item", timestamp: at(2000), payload: { type: "message", role: "user", content: [{ text: "Fixture prompt" }] } });
  const service = serviceOf({ locate: async () => null, read: async () => ({ entry: { fold } }), content: async () => "", clear() {} });
  const routes = new UiRoutes(service), paseo = apiOf([agent], async () => page([]));
  try {
    const route = "api/paseo-context/detail", input = { agentId: agent.id };
    const local = await routes.handle(route, input, paseo) as any;
    const wire = JSON.parse(JSON.stringify(await routes.rpc(route, input, paseo))).value;
    expect(wire).toMatchObject({ rev: local.value.rev, nodes: [{ text: "Fixture prompt" }], head: {
      current: local.value.head.current, nodes: [], events: [], requests: [], systems: local.value.head.systems,
    } });
    expect(JSON.stringify(wire).match(/Fixture prompt/g)).toHaveLength(1);
  } finally { routes.clear(); service.clear(); }
});
