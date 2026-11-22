import { useEffect, useLayoutEffect } from "react";
import { useComposers, useSettings, type PluginAgentPanelProps, type PluginButtonIconProps, type PluginButtonRegistration, type PluginClientContext, type PluginComposer, type PluginScreenProps, type PluginSidebarItemProps, type PluginSurfaceProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { FrameSurface } from "./client/frame";
import { messages } from "./client/messages";
import { PreferencesScreen } from "./client/preferences";
import { WorkspacePanels, WorkspaceSurface, type PanelMode } from "./client/workspace";
import { preferences, preferencesRpc, type Preferences } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController(), pills = new Map<string, PluginButtonRegistration>();
  const controller = new WorkspacePanels(), agents = controller.agents;
  const pillOwners = new Map<string, { workspaceId: string; token: symbol }>();
  let options: Preferences | null = null, generation = 0;
  let navigation: PluginSurfaceProps["navigation"];
  let pendingTabs: { agentId: string; workspaceId: string; first: PanelMode; rest: PanelMode[];
    source: PluginComposer; owner?: symbol; timer: ReturnType<typeof setTimeout> } | undefined;
  let panelRemovers: Array<() => void> = [], panelKey = "";
  let statisticsRemover: (() => void) | undefined;
  const staticRemovers: Array<() => void> = [];
  const track = (cleanup: unknown) => { if (typeof cleanup === "function") staticRemovers.push(cleanup as () => void); };
  const touched = new Set<string>();
  const openModal = (id: string) => client.openScreen({ screenId: "context", params: { agentId: id, mode: "modal" } });
  const openSettings = () => client.openSettings("preferences");
  async function openAgentPanel(panel: PanelMode, agentId: string, workspaceId?: string) {
    await ready;
    if (lifetime.signal.aborted) return;
    const workspace = workspaceId ?? agents.get(agentId)?.workspaceId;
    const available = panel === "context" ? options && options.defaultPlacement !== "hide" : panel === "fleet" ? options?.fleetTab : true;
    if (workspace && available && !agentId.startsWith("native:")) {
      controller.select(workspace, agentId);
      controller.activatePanel(workspace, panel);
      if (panel === "context" && options?.defaultPlacement === "sidebar") client.openPanel("context", { workspaceId: workspace, agentId, location: "explorer" });
      else client.openPanel(`workspace-${panel}`, { workspaceId: workspace, location: "workspace" });
    } else client.openScreen({ screenId: "context", params: { agentId, mode: panel } });
  }
  const openContext = (agentId: string, workspaceId?: string) => openAgentPanel("context", agentId, workspaceId);
  const common = { openSettings, openContext };
  function usePreferences() {
    const settings = useSettings(preferences);
    useEffect(() => { if (settings.status === "ready") updatePanels(settings.values); }, [settings.status === "ready" ? settings.revision : ""]);
    return settings;
  }
  function rememberNavigation(props: PluginSurfaceProps) { if (props.navigation) navigation = props.navigation; }
  function Context(props: PluginAgentPanelProps) { rememberNavigation(props); usePreferences(); return <FrameSurface {...props} {...common} mode="context" agentId={props.params.agentId} />; }
  function Fleet(props: PluginAgentPanelProps) { rememberNavigation(props); usePreferences(); return <FrameSurface {...props} {...common} mode="fleet" agentId={props.params.agentId} />; }
  function useWorkspaceSurface(props: PluginWorkspacePanelProps, mode: PanelMode) {
    rememberNavigation(props); usePreferences();
    // The first surface's commit supplies public navigation even on a cold
    // native client. Do not infer screen visibility from a composer's old ref.
    useLayoutEffect(() => {
      const pending = pendingTabs;
      if (!pending || pending.workspaceId !== props.workspaceId || pending.first !== mode) return;
      pendingTabs = undefined; clearTimeout(pending.timer);
      const focused = client.composers({ focused: true })[0], agent = agents.get(pending.agentId);
      if (lifetime.signal.aborted || !agent || agent.archivedAt || agent.workspaceId !== pending.workspaceId
        || focused && focused !== client.composers({ agentId: pending.agentId })[0]) {
        controller.fail(pending.agentId); return;
      }
      void finishTabs(pending.agentId, pending.workspaceId, pending.rest, pending.source, props.navigation).catch(report);
    });
  }
  function WorkspaceContext(props: PluginWorkspacePanelProps) { useWorkspaceSurface(props, "context"); return <WorkspaceSurface {...props} {...common} controller={controller} mode="context" />; }
  function WorkspaceFleet(props: PluginWorkspacePanelProps) { useWorkspaceSurface(props, "fleet"); return <WorkspaceSurface {...props} {...common} controller={controller} mode="fleet" />; }
  function WorkspaceStatistics(props: PluginWorkspacePanelProps) { useWorkspaceSurface(props, "statistics"); return <WorkspaceSurface {...props} {...common} controller={controller} mode="statistics" />; }
  function Screen(props: PluginScreenProps) {
    rememberNavigation(props);
    usePreferences();
    const modal = props.params.mode === "modal", id = props.params.agentId;
    return <FrameSurface {...props} {...common} mode={modal ? "modal" : props.params.mode === "fleet" ? "fleet" : props.params.mode === "statistics" ? "statistics" : "context"} agentId={id} overlay={modal}
      onClose={() => id && (id.startsWith("native:") || !props.navigation ? openContext(id) : props.navigation.openAgent({ agentId: id }))} />;
  }
  function Insights(props: PluginScreenProps) { rememberNavigation(props); usePreferences(); return <FrameSurface {...props} {...common} mode="insights" />; }
  function Settings(props: PluginSurfaceProps) { rememberNavigation(props); return <PreferencesScreen {...props} settings={usePreferences()} />; }
  function updatePanels(next: Preferences) {
    options = next;
    const key = `${next.defaultPlacement}:${next.fleetTab}`;
    if (key === panelKey) return;
    cancelPendingTabs();
    panelKey = key;
    for (const remove of panelRemovers) remove(); panelRemovers = [];
    if (next.defaultPlacement !== "hide") panelRemovers.push(client.addAgentPanel({
      id: "context", title: messages.message("context"), icon: "ChartNoAxesCombined",
      locations: next.defaultPlacement === "tab" ? ["workspace"] : next.defaultPlacement === "sidebar" ? ["explorer"] : ["workspace", "explorer"],
      Component: Context,
    }));
    if (next.fleetTab) panelRemovers.push(client.addAgentPanel({ id: "fleet", title: messages.message("fleet"), icon: "Network", locations: ["workspace", "explorer"], Component: Fleet }));
    if (next.defaultPlacement !== "hide" && next.defaultPlacement !== "sidebar") panelRemovers.push(client.addWorkspacePanel({
      id: "workspace-context", title: messages.message("context"), icon: "ChartNoAxesCombined", locations: ["workspace"], Component: WorkspaceContext,
    }));
    if (next.fleetTab) panelRemovers.push(client.addWorkspacePanel({ id: "workspace-fleet", title: messages.message("fleet"), icon: "Network", locations: ["workspace"], Component: WorkspaceFleet }));
    if (!statisticsRemover) {
      statisticsRemover = client.addWorkspacePanel({ id: "workspace-statistics", title: messages.message("statistics"), icon: "ChartPie", locations: ["workspace"], Component: WorkspaceStatistics });
    }
    controller.batch(() => {
      for (const agent of agents.values()) register(agent);
    });
  }
  function Entry(props: PluginSidebarItemProps) {
    const settings = usePreferences();
    return <>
      {settings.status === "ready" && settings.values.insightsEntry && <SidebarRow icon="ChartNoAxesCombined" active={props.currentScreen?.screenId === "insights"} onPress={() => props.openScreen({ screenId: "insights" })} />}
    </>;
  }
  track(client.addScreen({ id: "insights", title: messages.message("insights"), Component: Insights }));
  track(client.addScreen({ id: "context", title: messages.message("context"), Component: Screen }));
  track(client.addSidebarHeaderItem({ id: "insights", title: messages.message("insights"), Component: Entry }));
  track(client.addSettingsScreen({ id: "preferences", title: messages.message("settings"), icon: "Settings", Component: Settings }));
  track(client.addCommandCenterItem({ id: "insights", title: messages.message("insights"), icon: "ChartNoAxesCombined", context: "global",
    onSelect: ({ openScreen }) => openScreen({ screenId: "insights" }) }));
  track(client.addCommandCenterItem({ id: "context", title: messages.message("context"), icon: "ChartNoAxesCombined", context: "agent", onSelect: ({ agent, workspace }) => openContext(agent.id, workspace.id) }));
  track(client.addCommandCenterItem({ id: "fleet", title: messages.message("fleet"), icon: "Network", context: "agent", onSelect: ({ agent, workspace }) => openAgentPanel("fleet", agent.id, workspace.id) }));
  track(client.addCommandCenterItem({ id: "statistics", title: messages.message("statistics"), icon: "ChartPie", context: "agent", onSelect: ({ agent, workspace }) => openAgentPanel("statistics", agent.id, workspace.id) }));
  track(client.addCommandCenterItem({ id: "preferences", title: messages.message("settings"), icon: "Settings", context: "global", onSelect: ({ openSettings }) => openSettings("preferences") }));
  track(client.addSlashCommand({ name: "context", description: messages.message("context"), argumentHint: "[current | fleet | stats | insights | modal]", context: "agent",
    onSubmit: ({ args, agent, workspace, openScreen }) => {
      if (args === "fleet") return openAgentPanel("fleet", agent.id, workspace.id);
      if (args === "stats" || args === "statistics") return openAgentPanel("statistics", agent.id, workspace.id);
      if (args === "insights") openScreen({ screenId: "insights" });
      else if (args === "modal") openModal(agent.id);
      else return openContext(agent.id, workspace.id);
    } }));
  const ready = client.rpc(preferencesRpc, {}).then((values) => { if (!lifetime.signal.aborted && !options) updatePanels(values); }).catch((error) => {
    if (!lifetime.signal.aborted) console.error("[paseo-context] Preferences could not be loaded", error);
  });
  function cancelPendingTabs(owner?: symbol) {
    if (!pendingTabs || owner && pendingTabs.owner !== owner) return;
    clearTimeout(pendingTabs.timer); controller.fail(pendingTabs.agentId); pendingTabs = undefined;
  }
  async function finishTabs(agentId: string, workspaceId: string, modes: PanelMode[], source: PluginComposer, nav: PluginSurfaceProps["navigation"]) {
    try {
      for (const mode of modes) client.openPanel(`workspace-${mode}`, { workspaceId, location: "workspace" });
    } catch (error) { controller.fail(agentId); throw error; }
    controller.complete(agentId);
    pills.get(agentId)?.remove(); pills.delete(agentId);
    pillOwners.delete(agentId);
    if (nav) nav.openAgent({ agentId });
    else await source.focus();
  }
  async function initializeTabs(agentId: string, workspaceId: string, active = () => true, owner?: symbol) {
    await ready;
    const current = agents.get(agentId);
    const source = client.composers({ agentId })[0];
    if (!active() || lifetime.signal.aborted || !current || current.archivedAt || current.workspaceId !== workspaceId
      || !source || client.composers({ focused: true })[0] !== source
      || !options || options.defaultPlacement === "hide" || !controller.claim(agentId)) return;
    const modes: PanelMode[] = [...(options.defaultPlacement !== "sidebar" ? ["context" as const] : []),
      ...(options.fleetTab ? ["fleet" as const] : []), "statistics"];
    controller.select(workspaceId, agentId);
    if (navigation) return finishTabs(agentId, workspaceId, modes, source, navigation);
    cancelPendingTabs();
    const [first, ...rest] = modes;
    pendingTabs = { agentId, workspaceId, first, rest, source, owner,
      timer: setTimeout(() => cancelPendingTabs(), 2000) };
    try {
      client.openPanel(`workspace-${first}`, { workspaceId, location: "workspace" });
    } catch (error) { cancelPendingTabs(); throw error; }
  }
  function InitializeTabs(props: PluginButtonIconProps) {
    const focused = useComposers({ focused: true })[0];
    const owner = props.context === "agent" ? pillOwners.get(props.agentId)?.token : undefined;
    // Layout cleanup runs before a newly mounted panel's layout effect, even
    // when the source is removed in the very same React commit.
    useLayoutEffect(() => () => { if (owner) cancelPendingTabs(owner); }, [owner]);
    // Native clients retain hidden conversations. Mounting alone is not an
    // activity signal; only the host's focused composer may create default tabs.
    useEffect(() => {
      let active = true;
      if (pendingTabs && focused && focused !== client.composers({ agentId: pendingTabs.agentId })[0]) cancelPendingTabs();
      if (props.context === "agent") void initializeTabs(props.agentId, props.workspaceId, () => active, owner).catch(report);
      return () => { active = false; };
    }, [props.context === "agent" ? props.agentId : "", props.workspaceId, focused]);
    return null;
  }
  function register(agent: { id: string; workspaceId?: string; title?: string | null; archivedAt?: string | null }) {
    controller.upsert(agent);
    const eligible = agent.workspaceId && !agent.archivedAt && !lifetime.signal.aborted && options && options.defaultPlacement !== "hide";
    // Live agent updates must not remount the initialization icon while its
    // short-lived first-panel handoff is in progress.
    const sameWorkspace = pillOwners.get(agent.id)?.workspaceId === agent.workspaceId;
    if (eligible && sameWorkspace && pills.has(agent.id) && (!controller.hasInitialized(agent.id) || pendingTabs?.agentId === agent.id)) return;
    if ((!eligible || !sameWorkspace) && pendingTabs?.agentId === agent.id) cancelPendingTabs();
    pills.get(agent.id)?.remove(); pills.delete(agent.id);
    pillOwners.delete(agent.id);
    if (!agent.workspaceId || agent.archivedAt || lifetime.signal.aborted || !options || options.defaultPlacement === "hide" || controller.hasInitialized(agent.id)) return;
    const token = Symbol("default-tabs");
    pillOwners.set(agent.id, { workspaceId: agent.workspaceId, token });
    pills.set(agent.id, client.addComposerPill({ id: "initialize-tabs", workspaceId: agent.workspaceId, agentId: agent.id,
      button: { title: messages.message("preparing"), icon: InitializeTabs,
        behavior: { kind: "action", onPress: () => initializeTabs(agent.id, agent.workspaceId!, () => pillOwners.get(agent.id)?.token === token, token) } } }));
  }
  async function reconcile(first: Awaited<ReturnType<typeof client.paseo.agents.list>>) {
    const version = ++generation;
    touched.clear();
    const rows = new Map(first.entries.map(({ agent }) => [agent.id, agent]));
    let cursor = first.pageInfo.hasMore ? first.pageInfo.nextCursor : null;
    const seen = new Set<string>();
    while (cursor && !lifetime.signal.aborted && version === generation) {
      if (seen.has(cursor)) throw new Error("Agent directory returned a repeated cursor");
      seen.add(cursor);
      const page = await client.paseo.agents.list({ page: { cursor, limit: 200 }, signal: lifetime.signal });
      for (const { agent } of page.entries) rows.set(agent.id, agent);
      cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
    }
    if (lifetime.signal.aborted || version !== generation) return;
    controller.batch(() => {
      for (const id of agents.keys()) if (!rows.has(id) && !touched.has(id)) { controller.remove(id); pills.get(id)?.remove(); pills.delete(id); pillOwners.delete(id); }
      for (const agent of rows.values()) if (!touched.has(agent.id)) register(agent);
    });
  }
  const report = (error: unknown) => { if (!lifetime.signal.aborted) console.error("[paseo-context] Agent observation failed", error); };
  void client.paseo.agents.list({ page: { limit: 200 }, subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (lifetime.signal.aborted) return;
    subscription.subscribe({
      snapshot: (snapshot) => { void reconcile(snapshot).catch(report); },
      update: (message) => {
        if (lifetime.signal.aborted || message.type !== "agent_update") return;
        const update = message.payload, id = update.kind === "upsert" ? update.agent.id : update.agentId;
        touched.add(id);
        if (update.kind === "upsert") register(update.agent); else { controller.remove(id); pills.get(id)?.remove(); pills.delete(id); pillOwners.delete(id); }
      },
    });
  }).catch(report);
  return () => {
    lifetime.abort();
    cancelPendingTabs();
    for (const remove of panelRemovers) remove(); panelRemovers = [];
    statisticsRemover?.(); statisticsRemover = undefined;
    for (const remove of staticRemovers.splice(0)) remove();
    for (const pill of pills.values()) pill.remove(); pills.clear(); pillOwners.clear(); controller.clear(); touched.clear();
    navigation = undefined;
  };
}
