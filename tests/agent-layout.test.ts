import { expect, test } from "vitest";
import { agentForestOf, layoutForest, runningOnlyForestOf, AGENT_CARD_COMPACT_H, AGENT_CARD_H } from "../src/client/agentTree";

function forestOf(parents: Array<string | undefined>) {
  const byId = Object.fromEntries(parents.map((parentId, index) => [`a${index}`, {
    title: `Agent ${index}`, blank: false, updatedAt: index,
    ...(parentId ? { origin: "subagent", parentId } : {}),
  }]));
  return agentForestOf({ byId }, "a0")!;
}

test("the running filter retains the current agent and ancestors of running children", () => {
  const forest = forestOf([undefined, "a0", "a0", "a1"]);
  forest.nodes.find((node) => node.id === "a3")!.running = true;
  const filtered = runningOnlyForestOf(forest);
  expect(filtered.nodes.map((node) => node.id).sort()).toEqual(["a0", "a1", "a3"]);
  expect(filtered.edges.map((edge) => [edge.from, edge.to])).toEqual([["a0", "a1"], ["a1", "a3"]]);
});

test.each([false, true])("solo and single-child chains fit a measured narrow stage (compact=%s)", (compact) => {
  for (const width of [120, 180, 200, 280, 347, 700]) {
    for (const forest of [forestOf([undefined]), forestOf([undefined, "a0", "a1"])]) {
      const layout = layoutForest(forest, width, compact);
      expect(layout.width).toBeLessThanOrEqual(width);
      for (const point of layout.points) {
        expect(point.x - layout.cardW / 2).toBeGreaterThanOrEqual(0);
        expect(point.x + layout.cardW / 2).toBeLessThanOrEqual(width);
      }
    }
  }
});

test.each([false, true])("branch packing keeps every node reachable and links aligned (compact=%s)", (compact) => {
  const forest = forestOf([undefined, "a0", "a0", "a1", "a1", "a2", "a2", "a2"]);
  for (const width of [160, 240, 347, 430, 800]) {
    const layout = layoutForest(forest, width, compact);
    const cardHeight = compact ? AGENT_CARD_COMPACT_H : AGENT_CARD_H;
    expect(new Set(layout.points.map(point => point.id)).size).toBe(forest.nodes.length);
    for (const point of layout.points) {
      expect(point.x - layout.cardW / 2).toBeGreaterThanOrEqual(0);
      expect(point.x + layout.cardW / 2).toBeLessThanOrEqual(width);
      expect(point.y + cardHeight).toBeLessThanOrEqual(layout.height);
    }
    for (const link of layout.links) {
      const target = layout.points.find(point => point.id === link.to)!;
      const parentId = forest.nodes.find(node => node.id === link.to)!.parentId;
      const parent = layout.points.find(point => point.id === parentId)!;
      expect([link.x1, link.y1, link.x2, link.y2]).toEqual([parent.x, parent.y + cardHeight, target.x, target.y]);
    }
  }
});
