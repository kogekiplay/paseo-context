import type { PluginClientContext } from "@getpaseo/plugin/client";
import { act, create } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { preferenceSchema, type Preferences } from "../shared/contracts";

const mocks = vi.hoisted(() => ({ settings: { status: "loading" } as any, frame: vi.fn(() => null) }));
vi.mock("@getpaseo/plugin/client", () => ({
  useSettings: () => mocks.settings,
  defineTranslations: () => ({ message: (key: string) => key }),
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: () => null }));
vi.mock("../client/frame", () => ({ FrameSurface: mocks.frame }));
import contribute from "../index.client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  mocks.settings = { status: "loading" };
  vi.clearAllMocks();
});
function setup(input: Partial<Preferences> = {}) {
  const values = preferenceSchema.parse(input);
  let resolve!: (value: Preferences) => void;
  const pending = new Promise<Preferences>((done) => { resolve = done; });
  const commands: Record<string, any> = {}, screens: Record<string, any> = {};
  const panels = new Map<string, any>(), pills = new Map<string, any>();
  const removers: Array<ReturnType<typeof vi.fn>> = [];
  let observer: any, slash: any;
  const client = {
    rpc: vi.fn(() => pending), openPanel: vi.fn(), openScreen: vi.fn(), openSettings: vi.fn(),
    addAgentPanel: vi.fn((panel: any) => {
      panels.set(panel.id, panel);
      const remove = vi.fn(() => { panels.delete(panel.id); }); removers.push(remove);
      return remove;
    }),
    addScreen: (screen: any) => { screens[screen.id] = screen; },
    addSidebarHeaderItem: vi.fn(), addSettingsScreen: vi.fn(),
    addCommandCenterItem: (command: any) => { commands[command.id] = command; },
    addSlashCommand: (command: any) => { slash = command; },
    addComposerPill: vi.fn((pill: any) => {
      pills.set(pill.agentId, pill);
      const remove = vi.fn(() => { pills.delete(pill.agentId); }); removers.push(remove);
      return { remove };
    }),
    paseo: { agents: { list: vi.fn(async () => ({ subscription: { subscribe: (value: any) => { observer = value; } } })) } },
  };
  const dispose = contribute(client as unknown as PluginClientContext);
  cleanups.push(dispose);
  const invocation = { agent: { id: "agent-a" }, workspace: { id: "workspace-a" }, openScreen: vi.fn() };
  return {
    client, commands, screens, panels, pills, removers, dispose, invocation,
    resolve: () => resolve(values), submit: (args = "") => slash.onSubmit({ ...invocation, args }),
    snapshot: async () => {
      await Promise.resolve();
      observer.snapshot({ entries: [{ agent: { id: "agent-a", workspaceId: "workspace-a" } }], pageInfo: { hasMore: false } });
      await Promise.resolve();
    },
  };
}

describe("Agent panel navigation", () => {
  test("the composer and agent commands open real tabs for their originating agent", async () => {
    const h = setup(); h.resolve(); await h.snapshot();
    await h.pills.get("agent-a").button.behavior.onPress();
    await h.commands.context.onSelect(h.invocation);
    await h.submit(); await h.submit("current"); await h.submit("fleet");
    await h.commands.fleet.onSelect({ ...h.invocation, agent: { id: "agent-b" }, workspace: { id: "workspace-b" } });
    expect(h.client.openPanel.mock.calls).toEqual([
      ...Array.from({ length: 4 }, () => ["context", { agentId: "agent-a", workspaceId: "workspace-a", location: "workspace" }]),
      ["fleet", { agentId: "agent-a", workspaceId: "workspace-a", location: "workspace" }],
      ["fleet", { agentId: "agent-b", workspaceId: "workspace-b", location: "workspace" }],
    ]);
    expect(h.client.openScreen).not.toHaveBeenCalled();
  });
  test("waits for panel registration before opening a tab", async () => {
    const h = setup();
    const opening = h.submit();
    await Promise.resolve();
    expect(h.client.openPanel).not.toHaveBeenCalled();
    h.resolve(); await opening;
    expect(h.panels.has("context")).toBe(true);
    expect(h.client.openPanel).toHaveBeenCalledOnce();
  });
  test("respects Explorer-only placement for context while fleet uses workspace tabs", async () => {
    const h = setup({ defaultPlacement: "sidebar" }); h.resolve();
    await h.submit(); await h.submit("fleet");
    expect(h.client.openPanel.mock.calls).toEqual([
      ["context", { agentId: "agent-a", workspaceId: "workspace-a", location: "explorer" }],
      ["fleet", { agentId: "agent-a", workspaceId: "workspace-a", location: "workspace" }],
    ]);
  });
  test("hidden panels retain explicit screen access without opening unregistered tabs", async () => {
    const h = setup({ defaultPlacement: "hide", fleetTab: false }); h.resolve();
    await h.submit(); await h.submit("fleet");
    expect(h.panels.size).toBe(0);
    expect(h.client.openPanel).not.toHaveBeenCalled();
    expect(h.client.openScreen.mock.calls).toEqual([
      [{ screenId: "context", params: { agentId: "agent-a", mode: "context" } }],
      [{ screenId: "context", params: { agentId: "agent-a", mode: "fleet" } }],
    ]);
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(h.screens.context.Component,
      { params: { agentId: "agent-a", mode: "fleet" } })); });
    expect(mocks.frame).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "fleet", agentId: "agent-a", overlay: false }), undefined);
    await act(async () => renderer.unmount());
  });
  test("modal and insights remain explicit alternatives", async () => {
    const h = setup(); h.resolve();
    await h.submit("modal"); await h.submit("insights");
    expect(h.client.openPanel).not.toHaveBeenCalled();
    expect(h.client.openScreen).toHaveBeenCalledWith({ screenId: "context", params: { agentId: "agent-a", mode: "modal" } });
    expect(h.invocation.openScreen).toHaveBeenCalledWith({ screenId: "insights" });
  });
  test("native log sessions remain accessible without inventing a Paseo agent tab", async () => {
    const h = setup(); h.resolve();
    await h.commands.context.onSelect({ ...h.invocation, agent: { id: "native:codex/session" } });
    expect(h.client.openPanel).not.toHaveBeenCalled();
    expect(h.client.openScreen).toHaveBeenCalledWith({ screenId: "context", params: { agentId: "native:codex/session", mode: "context" } });
  });
  test("teardown removes owned panels and pills and cancels deferred navigation", async () => {
    const loaded = setup(); loaded.resolve(); await loaded.snapshot(); loaded.dispose();
    expect(loaded.panels.size).toBe(0); expect(loaded.pills.size).toBe(0);
    expect(loaded.removers.every((remove) => remove.mock.calls.length === 1)).toBe(true);
    const pending = setup(), opening = pending.submit();
    pending.dispose(); pending.resolve(); await opening;
    expect(pending.client.openPanel).not.toHaveBeenCalled();
    expect(pending.client.openScreen).not.toHaveBeenCalled();
  });
});
