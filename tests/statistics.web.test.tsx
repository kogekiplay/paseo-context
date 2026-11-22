import { act, create } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { aggregateTurn } from "../shared/core/stats-aggregate";
import type { StatsSnapshot, StatsStepMetrics } from "../shared/core/stats-contract";
import type { ViewKit } from "../src/client/viewkit";

vi.mock("../web/vendor/ui/index.js", () => ({
  HoverCard: ({ anchor }: any) => anchor, ImageLightbox: () => null,
  MarkdownText: ({ text }: any) => text,
  SegmentedControl: "SegmentedControl", Switch: "Switch",
}));
vi.mock("../web/bridge", () => ({ call: vi.fn(async () => null) }));
import { makeStatisticsView } from "../web/statistics";
import { call } from "../web/bridge";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const Statistics = makeStatisticsView({} as ViewKit);
let renderer: ReturnType<typeof create> | null = null;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = null;
});
function fixture(total: number, usage: number | null = null): StatsSnapshot {
  const steps: StatsStepMetrics[] = Array.from({ length: total }, (_, index) => ({
    turn: 1, step: index + 1, startTime: 1000 + index * 2000, endTime: 2000 + index * 2000,
    context: usage, output: usage, cacheRead: usage, cacheWrite: usage, cacheHit: null,
    ttft: null, decode: null, tps: null, model: 1000,
    tool: 0, toolWall: null, toolPending: 0, tools: [], calls: [], toolOutput: null,
    retries: 0, toolErrors: 0, answer: "Fixture answer", answerBody: "Fixture answer", answerTruncated: false,
    wall: 1000, running: false, interrupted: false, aborted: false,
  }));
  return { turns: total ? [{ ...aggregateTurn(1, steps), prompt: "Fixture prompt", promptSource: "user" }] : [], stepCount: total };
}
async function mount(snapshot: StatsSnapshot) {
  await act(async () => { renderer = create(createElement(Statistics,
    { sessionId: "agent-a", locale: "zh-CN", snapshot })); });
  return renderer!.root;
}
const textOf = (node: any): string => typeof node === "string" ? node : node.children.map(textOf).join("");
test("uses the original eleven-column table and all original footer controls", async () => {
  const root = await mount(fixture(3));
  expect(root.findByType("thead").findAllByType("th").map((cell) => cell.children.join(""))).toEqual([
    "轮次 / 步骤", "触发", "执行内容", "上下文", "输出", "缓存命中", "首 token", "模型用时", "输出速度", "工具用时", "总用时",
  ]);
  expect(root.findAllByType("Switch" as any).map((control) => control.props.label)).toEqual(["显示合计行", "显示事件行（含压缩）", "显示上下文增量"]);
  expect(root.findByType("SegmentedControl" as any).props.options.map((option: any) => option.value)).toEqual(["latest", "cumulative"]);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Fixture prompt");
});
test("the original show-all action exposes every captured step without losing a partial page", async () => {
  const root = await mount(fixture(103));
  const showAll = root.findAllByType("button").find((button) => button.children.some((child) => typeof child === "string" && child.includes("103")))!;
  expect(showAll).toBeDefined();
  await act(async () => showAll.props.onClick());
  const stepButtons = root.findAllByType("button").filter((button) => /^展开或折叠第 \d+ 步/.test(button.props["aria-label"] ?? ""));
  expect(stepButtons).toHaveLength(103);
});
test("missing provider fields stay unavailable while a real zero remains visible", async () => {
  const root = await mount(fixture(1));
  const cells = root.findByType("tbody").findAllByType("tr").at(-1)!.findAllByType("td");
  expect(textOf(cells[3])).toBe("—");
  expect(textOf(cells[4])).toBe("—");
  expect(cells.at(-1)!.props.title).toContain("首 token —");
  expect(cells.at(-1)!.props.title).toContain("生成 —");
  await act(async () => renderer!.update(createElement(Statistics, { sessionId: "agent-a", locale: "zh-CN", snapshot: fixture(1, 0) })));
  expect(textOf(root.findByType("tbody").findAllByType("tr").at(-1)!.findAllByType("td")[3])).toBe("0.00K");
});
test("empty sessions use the original empty state and disable expand-all", async () => {
  const root = await mount(fixture(0));
  expect(root.findAllByType("table")).toHaveLength(0);
  expect(root.findAllByType("button").at(-1)!.props.disabled).toBe(true);
});
test("cache tooltip preserves an unreported write bucket at step and turn level", async () => {
  const source = fixture(1, 100);
  const steps = source.turns[0].steps.map((step) => ({ ...step, cacheRead: 10, cacheWrite: null, cacheHit: 0.1 }));
  const root = await mount({ turns: [aggregateTurn(1, steps)], stepCount: 1 });
  const tooltips = root.findAllByType("td").map((cell) => cell.props.title).filter((title): title is string => typeof title === "string" && title.includes("缓存读"));
  expect(tooltips.length).toBeGreaterThan(0);
  expect(tooltips.every((title) => title.includes("缓存写 —"))).toBe(true);
});
test("expanded details refresh on content revision changes and ignore an old late response", async () => {
  const snapshot = (revision: string): StatsSnapshot => {
    const source = fixture(1);
    const steps = source.turns[0].steps.map((step) => ({
      ...step, sourceId: "step:one", contentRevision: revision, detailsState: "unloaded" as const,
    }));
    return { turns: [{ ...source.turns[0], steps }], stepCount: 1 };
  };
  const requests: Array<{ resolve: (value: unknown) => void; signal: AbortSignal }> = [];
  vi.mocked(call).mockImplementation((_route, _input, options) => new Promise((resolve) => requests.push({ resolve, signal: options!.signal! })));
  const root = await mount(snapshot("a"));
  const target = { closest: () => ({ getAttribute: () => "step:one" }) };
  await act(async () => root.findByProps({ className: "pc-statistics" }).props.onClickCapture({ target }));
  expect(requests).toHaveLength(1);
  await act(async () => renderer!.update(createElement(Statistics, { sessionId: "agent-a", locale: "zh-CN", snapshot: snapshot("b") })));
  expect(requests).toHaveLength(2);
  expect(requests[0].signal.aborted).toBe(true);
  await act(async () => requests[1].resolve({ requestId: "step:one", contentRevision: "b", calls: [], answerBody: "current body", answerTruncated: false }));
  await act(async () => requests[0].resolve({ requestId: "step:one", contentRevision: "a", calls: [], answerBody: "stale body", answerTruncated: false }));
  const expand = root.findAllByType("button").find((button) => button.props["aria-label"] === "展开或折叠第 1 步的工具详情")!;
  await act(async () => expand.props.onClick({ stopPropagation() {} }));
  expect(JSON.stringify(renderer!.toJSON())).toContain("current body");
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("stale body");
  await act(async () => renderer!.update(createElement(Statistics, { sessionId: "agent-a", locale: "zh-CN", snapshot: snapshot("c") })));
  expect(requests).toHaveLength(3);
  // Collapsing the step stops further automatic background detail refetches on poll updates.
  const collapseTarget = {
    closest: () => ({
      getAttribute: () => "step:one",
      querySelector: () => ({ getAttribute: () => "true" }),
    }),
  };
  await act(async () => root.findByProps({ className: "pc-statistics" }).props.onClickCapture({ target: collapseTarget }));
  expect(requests[2].signal.aborted).toBe(true);
  await act(async () => renderer!.update(createElement(Statistics, { sessionId: "agent-a", locale: "zh-CN", snapshot: snapshot("d") })));
  expect(requests).toHaveLength(3);
  await act(async () => renderer!.unmount());
  renderer = null;
});
