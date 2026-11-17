import { describe, expect, test, vi } from "vitest";
import { ContextFold } from "../server/fold";
import type { Agent } from "../shared/contracts";
import type { ContextService } from "../server/service";
import type { PaseoApi } from "@getpaseo/client";
import { UiRoutes } from "../server/ui-routes";
import { grammarOf } from "../server/grammars";
import { createHighlighterCoreSync, createCssVariablesTheme } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

function fixture() {
  const agent: Agent = { id: "a", workspaceId: "workspace", parentId: null, title: "Test", cwd: "/test",
    provider: "codex", model: "test", sessionId: "fixture", createdAt: 0, updatedAt: 5000, running: false, archived: false };
  const fold = new ContextFold("codex");
  fold.apply({ type: "response_item", timestamp: "2026-11-17T00:00:00Z",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] } });
  const data = { agent, fold, requests: fold.requests, summary: fold.summary(agent), revision: 42 };
  const service = { agent: vi.fn(async () => agent), load: vi.fn(async () => data),
    directory: vi.fn(async () => [{ ...agent, labels: {}, createdAt: new Date(0).toISOString(), updatedAt: new Date(5000).toISOString() }]),
    fleet: vi.fn(async () => { throw new Error("Unrelated fleet should not be read"); }),
    pricing: { refresh: vi.fn(async () => {}) } };
  return { service, routes: new UiRoutes(service as unknown as ContextService), paseo: {} as PaseoApi };
}
describe("Page-specific bootstrap payloads", () => {
  test("context returns complete content once without reading a fleet or triggering slim-head refetches", async () => {
    const { service, routes, paseo } = fixture();
    const value: any = await routes.handle("bootstrap", { agentId: "a", mode: "context" }, paseo);
    expect(value.sessions).toHaveLength(1);
    expect(value.sessions[0].projectionValues).toEqual({});
    expect(value.selected.head.nodes[0].text).toBe("Hello");
    expect(value.selected.head.detailRev).toBe(42);
    expect(value.selected.head.paseoComplete).toBe(true);
    expect(value.selected.revision).toBe(42);
    expect(service.fleet).not.toHaveBeenCalled();
    const unchanged: any = await routes.handle("bootstrap", { agentId: "a", mode: "context", revision: 42 }, paseo);
    expect(unchanged.selected).toEqual({ unchanged: true, revision: 42 });
    expect(JSON.stringify(unchanged).length).toBeLessThan(500);
    routes.clear();
  });
  test("statistics sends only its own table; settings and insights do not load any agent", async () => {
    const { service, routes, paseo } = fixture();
    const value: any = await routes.handle("bootstrap", { agentId: "a", mode: "statistics" }, paseo);
    expect(value.selected.statistics).toHaveProperty("turns");
    expect(value.selected.head).toBeUndefined();
    expect(value.selected.headers).toBeUndefined();
    service.agent.mockClear(); service.load.mockClear();
    for (const mode of ["settings", "insights"]) {
      expect(await routes.handle("bootstrap", { mode, agentId: "a" }, paseo)).toEqual({ sessions: [], selected: null });
    }
    expect(service.agent).not.toHaveBeenCalled();
    expect(service.load).not.toHaveBeenCalled();
    routes.clear();
  });
  test("a single cold child head uses the same compact graph contract as a batch", async () => {
    const { routes, paseo } = fixture();
    const full: any = await routes.handle("api/paseo-context/detail", { sessionId: "a" }, paseo);
    const single: any = await routes.handle("api/paseo-context/detail", { sessionId: "a", head: true }, paseo);
    const batch: any = await routes.handle("api/paseo-context/heads", { ids: ["a"] }, paseo);
    expect(full.value.head.nodes).toHaveLength(1);
    expect(single.value.head).toEqual(batch.value.a.head);
    expect(single.value.nodes).toBeUndefined();
    expect(single.value.head.nodes).toEqual([]);
    expect(single.value.head.current.total).toBe(full.value.head.current.total);
    routes.clear();
  });
  test("offline grammar data retains embedded registrations and rejects arbitrary module names", () => {
    const highlighter = createHighlighterCoreSync({ themes: [createCssVariablesTheme()], langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }) });
    try {
      for (const name of ["typescript", "python", "vue"]) {
        highlighter.loadLanguageSync(grammarOf(name) as any);
        expect(highlighter.codeToHtml("const answer = 42", { lang: name, theme: "css-variables" })).toContain("shiki");
      }
      expect(() => grammarOf("__proto__")).toThrow("Unsupported");
      expect(() => grammarOf("../file")).toThrow("Unsupported");
    } finally { highlighter.dispose(); }
  });
});
