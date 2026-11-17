import { act, create } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fmt, fmtDuration, fmtShare } from "../src/client/format";
import type { ViewKit } from "../src/client/viewkit";

const mocks = vi.hoisted(() => ({ session: { data: null, usage: null, breakdown: null } as any }));
vi.mock("../src/client/sessionData", () => ({ useContextSession: () => mocks.session }));
vi.mock("../src/client/components/statsTiming", () => ({ makeStatsTiming: () => () => null }));
import { makeStatisticsView } from "../web/statistics";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const Statistics = makeStatisticsView({ t: (key: string) => key, fmt, fmtDuration, fmtShare, catLabel: (key: string) => key } as ViewKit);
let renderer: ReturnType<typeof create> | null = null;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = null; mocks.session = { data: null, usage: null, breakdown: null };
});
async function mount() {
  await act(async () => { renderer = create(createElement(Statistics,
    { sessionId: "agent-a", locale: "zh-CN", notices: ["Only captured provider fields are available."] })); });
  return renderer!.root;
}
function fixture(total = 0) {
  mocks.session.data = { provider: "codex", model: "test",
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 }, counts: { turns: 2, steps: total },
    requests: Array.from({ length: total }, (_, seq) => ({ seq, turn: 2, step: seq + 1, prompt: seq, output: seq, cacheRead: seq, activeMs: seq * 1000 })) };
}
test("request statistics page through the complete history without omitting the final partial page", async () => {
  fixture(103); const root = await mount(), seen: number[] = [];
  for (let page = 0; page < 3; page++) {
    const rows = root.findByType("tbody").findAllByType("tr");
    seen.push(...rows.map((row) => Number(row.findAllByType("td")[1].children.join(""))));
    if (page < 2) await act(async () => root.findAllByType("button")[1].props.onClick());
    else expect(root.findAllByType("button")[1].props.disabled).toBe(true);
  }
  expect(seen).toEqual(Array.from({ length: 103 }, (_, index) => 102 - index));
  expect(new Set(seen).size).toBe(103);
});
test("missing provider usage, request fields and prices stay unavailable rather than becoming zero", async () => {
  fixture();
  mocks.session.data.requests = [{ seq: 1, turn: 1, step: 1 }];
  const root = await mount();
  expect(root.findByType("tbody").findAllByType("td").slice(1).map((cell) => cell.children.join(""))).toEqual(["—", "—", "—", "—"]);
  expect(root.findAllByType("strong").slice(2).map((cell) => cell.children.join(""))).toEqual(["—", "—"]);
  const notes = root.findAllByType("p").map((node) => node.children.join(""));
  expect(notes.some((note) => note.includes("组成、价格和可观测耗时为估算"))).toBe(true);
  expect(notes).toContain("Only captured provider fields are available.");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("≈0");
  expect(root.findAllByType("svg")).toHaveLength(0);
});
test("a genuine provider zero report still renders the original token chart", async () => {
  fixture();
  mocks.session.usage = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const root = await mount();
  expect(root.findAllByType("svg").length).toBeGreaterThan(0);
  expect(root.findAllByType("strong")[2].children.join("")).toBe("0");
});
test("an empty history keeps one disabled page and a genuine zero price is displayed", async () => {
  fixture();
  mocks.session.data.costRead = { ready: true, usd: 0 };
  const root = await mount();
  expect(root.findByType("tbody").findAllByType("tr")).toHaveLength(0);
  expect(root.findAllByType("button").every((button) => button.props.disabled)).toBe(true);
  expect(root.findAllByType("strong").at(-1)!.children.join("")).toBe("$0.0000");
});
