import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { previewAgentId } from "../shared/bridge";
import { preferenceSchema } from "../shared/contracts";
import { SettingsPreview } from "../server/settings-preview";

const preview = new SettingsPreview(() => Date.now());
const read = (route: string, payload: object = {}) => preview.handle(route, payload) as Promise<any>;
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 10, 19, 12).getTime()); });
afterEach(() => { preview.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("old prompt preferences are ignored without resetting other values", () => {
  const legacy = { promptPrefix: "Old prefix", promptSuffix: "Old suffix", fleetTab: false, defaultTrendMode: "delta" };
  expect(preferenceSchema.parse(legacy)).toEqual({
    ...preferenceSchema.parse({}), fleetTab: false, defaultTrendMode: "delta", balanceSource: "account",
  });
});

test("balance source defaults to account, accepts api, and rejects other values", () => {
  expect(preferenceSchema.parse({}).balanceSource).toBe("account");
  expect(preferenceSchema.parse({ balanceSource: "account" }).balanceSource).toBe("account");
  expect(preferenceSchema.parse({ balanceSource: "api" }).balanceSource).toBe("api");
  expect(preferenceSchema.safeParse({ balanceSource: "auto" }).success).toBe(false);
});

test("all preview pages use the same sample sessions, with drill-down and no external reads", async () => {
  const fetch = vi.fn(() => Promise.reject(new Error("Unexpected network request")));
  vi.stubGlobal("fetch", fetch);
  const input = { agentId: previewAgentId };
  const { selected: { head } } = await read("bootstrap", { ...input, mode: "context" });
  expect(head.requests.length).toBeGreaterThan(100);
  expect(head.contextWindow).toBe(400000);
  const { value: milestones } = await read("api/paseo-context/history", { ...input, part: "milestones" });
  expect(milestones).toMatchObject({ rev: head.detailRev, live: true, part: "milestones" });
  expect(milestones.rows).toContainEqual(expect.objectContaining({
    kind: "ask", count: 1, name: "Which layout should the dashboard use?",
  }));
  const edit = head.fileOps.find((file: any) => file.kind === "write");
  expect(edit).toMatchObject({ path: "src/chart.tsx", added: 1, removed: 1 });
  await expect(read("api/paseo-context/file.preview", { path: edit.path })).resolves.toMatchObject({ name: edit.path });
  const fleet = await read("bootstrap", { ...input, mode: "fleet" });
  expect(fleet.sessions).toHaveLength(3);
  expect(fleet.sessions[0].projectionValues.agentTeam.tasks).toHaveLength(2);
  const stats = await read("bootstrap", { ...input, mode: "statistics" });
  const step = stats.selected.statistics.turns.flatMap((turn: any) => turn.steps).find((row: any) => row.calls.length);
  const details = await read("statistics.details", { ...input, requestId: step.sourceId });
  expect(details.calls[0].text).toBeTruthy();
  for (const [range, expected] of [["today", 2], ["7d", 2], ["30d", 3]] as const) {
    const { value } = await read("api/paseo-context/overview", { part: "summary", scope: { range } });
    expect(value.summary.sessions).toBe(expected);
    expect(value.summary.tokens).toBeGreaterThan(0);
  }
  const scope = { range: "7d", calendar: { from: "2026-11-19", to: "2026-11-19" } };
  const { value: { projects } } = await read("api/paseo-context/overview", { part: "projects", scope });
  const { value: { summary } } = await read("api/paseo-context/overview", { part: "summary", scope });
  expect(projects).toEqual([{ key: "/demo/atlas", sessions: 2, tokens: summary.tokens }]);
  expect(summary.window).toMatchObject({ from: "2026-11-19", to: "2026-11-19" });
  expect(fetch).not.toHaveBeenCalled();
});

test("the sample keeps today's activity and refreshes revisions across local midnight", async () => {
  let now = new Date(2026, 10, 18, 23, 59, 59).getTime();
  vi.mocked(Date.now).mockImplementation(() => now);
  const sample = new SettingsPreview(() => now);
  const request = { agentId: previewAgentId, mode: "context" };
  try {
    const before = await sample.handle("bootstrap", request) as any;
    now += 2000;
    const after = await sample.handle("bootstrap", { ...request, revision: before.selected.revision, familyRevision: before.familyRevision }) as any;
    expect(after.sessions).toHaveLength(3);
    expect(after.selected.head.requests).not.toEqual(before.selected.head.requests);
    const { value } = await sample.handle("api/paseo-context/overview", { part: "summary", scope: { range: "today" } }) as any;
    expect(value.summary.sessions).toBe(2);
  } finally { sample.clear(); }
});

test("preview cannot resolve a real agent, read arbitrary paths or write host settings", async () => {
  await expect(read("bootstrap", { agentId: "real-agent", mode: "context" })).rejects.toThrow("Agent is no longer available");
  await expect(read("api/paseo-context/file.preview", { path: "/etc/passwd" })).rejects.toThrow("Sample file is unavailable");
  await expect(read("settings.set", { field: "fleetTab", value: "hide" })).rejects.toThrow("Unavailable in settings preview");
});
