import type { PluginClientContext } from "@getpaseo/plugin/client";
import { act, create } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { preferenceSchema, type Preferences } from "../shared/contracts";

const mocks = vi.hoisted(() => ({ settings: { status: "loading" } as any, frame: vi.fn(() => null), agents: {} as Record<string, any>,
  focused: "agent-a" as string | null, composers: {
    "agent-a": { focus: vi.fn(async () => {}) }, "agent-b": { focus: vi.fn(async () => {}) },
  } }));
vi.mock("react-native", () => ({ View: "View", Text: "Text" }));
vi.mock("@getpaseo/plugin/client", () => ({
  useSettings: () => mocks.settings,
  defineTranslations: () => ({ message: (key: string) => key }),
  useTranslation: () => ({ t: (key: string) => key }),
  useAgent: (id: string, select: (agent: any) => unknown) => mocks.agents[id] ? select(mocks.agents[id]) : null,
  useTabState: (tab: any, _schema: unknown, defaults: unknown) => [tab.state ?? defaults, (value: unknown) => tab.setState(value)],
  useComposers: () => mocks.focused ? [mocks.composers[mocks.focused as keyof typeof mocks.composers]] : [],
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SidebarRow: () => null, Icon: () => null, Modal: Object.assign(() => null, { Content: () => null }),
}));
vi.mock("../client/frame", () => ({ FrameSurface: mocks.frame }));
import contribute from "../index.client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  mocks.settings = { status: "loading" };
  mocks.agents = {};
  mocks.focused = "agent-a";
  vi.clearAllMocks();
});
function setup(input: Partial<Preferences> = {}) {
  const values = preferenceSchema.parse(input);
  let resolve!: (value: Preferences) => void;
  const pending = new Promise<Preferences>((done) => { resolve = done; });
  const commands: Record<string, any> = {}, screens: Record<string, any> = {};
  const panels = new Map<string, any>(), workspacePanels = new Map<string, any>(), pills = new Map<string, any>();
  const removers: Array<ReturnType<typeof vi.fn>> = [];
  let observer: any, slash: any;
  const client = {
    rpc: vi.fn(() => pending), openPanel: vi.fn(), openScreen: vi.fn(), openSettings: vi.fn(),
    composers: (selector: { agentId?: string; focused?: boolean }) => {
      const id = selector.agentId ?? mocks.focused;
      return id && id in mocks.composers ? [mocks.composers[id as keyof typeof mocks.composers]] : [];
    },
    addAgentPanel: vi.fn((panel: any) => {
      panels.set(panel.id, panel);
      const remove = vi.fn(() => { panels.delete(panel.id); }); removers.push(remove);
      return remove;
    }),
    addWorkspacePanel: vi.fn((panel: any) => {
      workspacePanels.set(panel.id, panel);
      const remove = vi.fn(() => { workspacePanels.delete(panel.id); }); removers.push(remove);
      return remove;
    }),
    addScreen: (screen: any) => { screens[screen.id] = screen; },
    addSidebarHeaderItem: vi.fn(), addSettingsScreen: vi.fn(),
    addCommandCenterItem: (command: any) => { commands[command.id] = command; },
    addSlashCommand: (command: any) => { slash = command; },
    addComposerPill: vi.fn((pill: any) => {
      if (pill.button.label !== undefined && !pill.button.label.trim()) throw new Error("Plugin button needs label");
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
    client, commands, screens, panels, workspacePanels, pills, removers, dispose, invocation,
    resolve: () => resolve(values), submit: (args = "") => slash.onSubmit({ ...invocation, args }),
    snapshot: async () => {
      await Promise.resolve();
      mocks.agents["agent-a"] = { id: "agent-a", workspaceId: "workspace-a", title: "Agent A" };
      observer.snapshot({ entries: [{ agent: mocks.agents["agent-a"] }], pageInfo: { hasMore: false } });
      await Promise.resolve();
    },
  };
}

describe("Workspace tabs", () => {
  test("registers context, fleet and statistics in the workspace + menu", async () => {
    const h = setup(); h.resolve(); await h.snapshot();
    expect([...h.workspacePanels.keys()]).toEqual(["workspace-context", "workspace-fleet", "workspace-statistics"]);
    expect([...h.workspacePanels.values()].map((panel) => panel.title)).toEqual(["context", "fleet", "statistics"]);
    expect([...h.workspacePanels.values()].every((panel) => panel.locations.join() === "workspace")).toBe(true);
    expect(h.pills.get("agent-a").id).toBe("initialize-tabs");
    expect(h.pills.get("agent-a").button.label).toBeUndefined();
  });
  test("initializes all tabs then returns to the source conversation and removes its temporary registration", async () => {
    const h = setup(); h.resolve(); await h.snapshot();
    let icon!: ReturnType<typeof create>;
    await act(async () => { icon = create(createElement(h.pills.get("agent-a").button.icon,
      { context: "agent", agentId: "agent-a", workspaceId: "workspace-a" })); });
    expect(h.client.openPanel.mock.calls).toEqual([
      ["workspace-context", { workspaceId: "workspace-a", location: "workspace" }],
      ["workspace-fleet", { workspaceId: "workspace-a", location: "workspace" }],
      ["workspace-statistics", { workspaceId: "workspace-a", location: "workspace" }],
    ]);
    expect(mocks.composers["agent-a"].focus).toHaveBeenCalledOnce();
    expect(mocks.composers["agent-a"].focus.mock.invocationCallOrder[0]).toBeGreaterThan(h.client.openPanel.mock.invocationCallOrder.at(-1)!);
    expect(mocks.composers["agent-b"].focus).not.toHaveBeenCalled();
    expect(h.pills.size).toBe(0);
    const navigation = { openAgent: vi.fn() }, tab = { state: undefined, setState: vi.fn() };
    let panel!: ReturnType<typeof create>;
    await act(async () => { panel = create(createElement(h.workspacePanels.get("workspace-statistics").Component, {
      workspaceId: "workspace-a", navigation, tab,
      theme: { colors: { surface0: "white", foregroundMuted: "gray", border: "gray" } },
    })); });
    expect(navigation.openAgent).not.toHaveBeenCalled();
    expect(mocks.frame).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "agent-a", mode: "statistics" }), undefined);
    expect(tab.setState).toHaveBeenCalledWith({ agentId: "agent-a" });
    await h.snapshot();
    expect(h.pills.size).toBe(0);
    await act(async () => { icon.unmount(); panel.unmount(); });
  });
  test("agent commands select the originating workspace without opening standalone screens", async () => {
    const h = setup(); h.resolve(); await h.snapshot();
    await h.commands.context.onSelect(h.invocation);
    await h.submit(); await h.submit("current"); await h.submit("fleet");
    await h.commands.fleet.onSelect({ ...h.invocation, agent: { id: "agent-b" }, workspace: { id: "workspace-b" } });
    await h.submit("stats");
    expect(h.client.openPanel.mock.calls).toEqual([
      ...Array.from({ length: 3 }, () => ["workspace-context", { workspaceId: "workspace-a", location: "workspace" }]),
      ["workspace-fleet", { workspaceId: "workspace-a", location: "workspace" }],
      ["workspace-fleet", { workspaceId: "workspace-b", location: "workspace" }],
      ["workspace-statistics", { workspaceId: "workspace-a", location: "workspace" }],
    ]);
    expect(h.client.openScreen).not.toHaveBeenCalled();
  });
  test("uses a host-bound surface navigator synchronously when available instead of stale input visibility", async () => {
    const h = setup(); h.resolve(); await h.snapshot();
    const navigation = { openAgent: vi.fn() }, tab = { state: undefined, setState: vi.fn() };
    let panel!: ReturnType<typeof create>;
    await act(async () => { panel = create(createElement(h.workspacePanels.get("workspace-statistics").Component, {
      workspaceId: "workspace-a", navigation, tab,
      theme: { colors: { surface0: "white", foregroundMuted: "gray", border: "gray" } },
    })); });
    await h.pills.get("agent-a").button.behavior.onPress();
    expect(h.client.openPanel).toHaveBeenCalledTimes(3);
    expect(navigation.openAgent).toHaveBeenCalledExactlyOnceWith({ agentId: "agent-a" });
    expect(navigation.openAgent.mock.invocationCallOrder[0]).toBeGreaterThan(h.client.openPanel.mock.invocationCallOrder.at(-1)!);
    expect(mocks.composers["agent-a"].focus).not.toHaveBeenCalled();
    await act(async () => panel.unmount());
  });
  test("workspace tabs share the selected agent, persist it and reject agents from other workspaces", async () => {
    const h = setup(); h.resolve(); await h.snapshot();
    const navigation = { openAgent: vi.fn() }, tab = { state: { agentId: "other-workspace-agent" }, setState: vi.fn() };
    mocks.agents["other-workspace-agent"] = { id: "other-workspace-agent", workspaceId: "workspace-b" };
    let panel!: ReturnType<typeof create>;
    const props = { workspaceId: "workspace-a", navigation, tab,
      theme: { colors: { surface0: "white", foregroundMuted: "gray", border: "gray" } } };
    await act(async () => { panel = create(createElement(h.workspacePanels.get("workspace-statistics").Component, props)); });
    expect(mocks.frame).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "agent-a", mode: "statistics" }), undefined);
    expect(tab.setState).toHaveBeenCalledWith({ agentId: "agent-a" });
    await act(async () => panel.unmount());
    expect(navigation.openAgent).not.toHaveBeenCalled();
  });
  test("disabled placement avoids default initialization, and teardown cancels it before navigation", async () => {
    const hidden = setup({ defaultPlacement: "hide" }); hidden.resolve(); await hidden.snapshot();
    expect(hidden.pills.size).toBe(0);
    const h = setup(); h.resolve(); await h.snapshot();
    const opening = h.pills.get("agent-a").button.behavior.onPress();
    h.dispose(); await opening;
    expect(h.client.openPanel).not.toHaveBeenCalled();
    expect(mocks.composers["agent-a"].focus).not.toHaveBeenCalled();
  });
  test("retained background composers never create default tabs or change focus", async () => {
    const h = setup(); h.resolve(); await h.snapshot();
    mocks.focused = "agent-b";
    let icon!: ReturnType<typeof create>;
    await act(async () => { icon = create(createElement(h.pills.get("agent-a").button.icon,
      { context: "agent", agentId: "agent-a", workspaceId: "workspace-a" })); });
    expect(h.client.openPanel).not.toHaveBeenCalled();
    expect(mocks.composers["agent-a"].focus).not.toHaveBeenCalled();
    expect(mocks.composers["agent-b"].focus).not.toHaveBeenCalled();
    expect(h.pills.size).toBe(1);
    await act(async () => icon.unmount());
  });
  test("a failed default tab opening rolls back its claim and supports retry", async () => {
    const h = setup(); h.resolve(); await h.snapshot();
    const run = h.pills.get("agent-a").button.behavior.onPress;
    h.client.openPanel.mockImplementationOnce(() => { throw new Error("Workspace not ready"); });
    await expect(run()).rejects.toThrow("Workspace not ready");
    expect(h.pills.size).toBe(1);
    expect(mocks.composers["agent-a"].focus).not.toHaveBeenCalled();
    await run();
    expect(h.client.openPanel).toHaveBeenCalledTimes(4);
    expect(mocks.composers["agent-a"].focus).toHaveBeenCalledOnce();
    expect(h.pills.size).toBe(0);
  });
  test("a refused input focus never retries completed tab creation", async () => {
    const h = setup(); h.resolve(); await h.snapshot();
    const run = h.pills.get("agent-a").button.behavior.onPress;
    mocks.composers["agent-a"].focus.mockRejectedValueOnce(new Error("Input refused focus"));
    await expect(run()).rejects.toThrow("Input refused focus");
    await h.snapshot(); await run();
    expect(h.client.openPanel).toHaveBeenCalledTimes(3);
    expect(mocks.composers["agent-a"].focus).toHaveBeenCalledOnce();
    expect(h.pills.size).toBe(0);
  });
  test("panel mounting never schedules a delayed jump after the user leaves the source host", async () => {
    const h = setup(); h.resolve(); await h.snapshot();
    await h.pills.get("agent-a").button.behavior.onPress();
    mocks.focused = null;
    const navigation = { openAgent: vi.fn() }, tab = { state: undefined, setState: vi.fn() };
    let panel!: ReturnType<typeof create>;
    await act(async () => { panel = create(createElement(h.workspacePanels.get("workspace-statistics").Component, {
      workspaceId: "workspace-a", navigation, tab,
      theme: { colors: { surface0: "white", foregroundMuted: "gray", border: "gray" } },
    })); });
    expect(navigation.openAgent).not.toHaveBeenCalled();
    await act(async () => panel.unmount());
  });
  test("waits for panel registration before opening a tab", async () => {
    const h = setup();
    const opening = h.submit();
    await Promise.resolve();
    expect(h.client.openPanel).not.toHaveBeenCalled();
    h.resolve(); await opening;
    expect(h.workspacePanels.has("workspace-context")).toBe(true);
    expect(h.client.openPanel).toHaveBeenCalledOnce();
  });
  test("respects Explorer-only placement for context while fleet uses workspace tabs", async () => {
    const h = setup({ defaultPlacement: "sidebar" }); h.resolve();
    await h.submit(); await h.submit("fleet");
    expect(h.client.openPanel.mock.calls).toEqual([
      ["context", { agentId: "agent-a", workspaceId: "workspace-a", location: "explorer" }],
      ["workspace-fleet", { workspaceId: "workspace-a", location: "workspace" }],
    ]);
  });
  test("hidden panels retain explicit screen access without opening unregistered tabs", async () => {
    const h = setup({ defaultPlacement: "hide", fleetTab: false }); h.resolve();
    await h.submit(); await h.submit("fleet");
    expect(h.panels.size).toBe(0);
    expect([...h.workspacePanels.keys()]).toEqual(["workspace-statistics"]);
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
    expect(loaded.workspacePanels.size).toBe(0);
    expect(loaded.removers.every((remove) => remove.mock.calls.length === 1)).toBe(true);
    const pending = setup(), opening = pending.submit();
    pending.dispose(); pending.resolve(); await opening;
    expect(pending.client.openPanel).not.toHaveBeenCalled();
    expect(pending.client.openScreen).not.toHaveBeenCalled();
  });
});
