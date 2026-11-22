import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useAgent, useTabState, useTranslation, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { z } from "zod";
import { AgentPicker } from "./agent-picker";
import { FrameSurface } from "./frame";
import { messages } from "./messages";

export type PanelMode = "context" | "fleet" | "statistics";
export interface PanelAgent { id: string; workspaceId?: string; title?: string | null; archivedAt?: string | null }
const stateSchema = z.object({ agentId: z.string().optional() });
const MAX_WORKSPACES = 128, MAX_PANEL_ACTIVATIONS = MAX_WORKSPACES * 4, MAX_INITIALIZED_AGENTS = 512;
function remember<T>(map: Map<string, T>, key: string, value: T, limit: number) {
  map.delete(key); map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value!);
}

/** Client-owned selection only. Session contents remain in the existing bounded data layer. */
export class WorkspacePanels {
  readonly agents = new Map<string, PanelAgent>();
  private selected = new Map<string, string>();
  private initialized = new Map<string, true>();
  private initializing = new Set<string>();
  private listeners = new Set<() => void>();
  private workspaceListeners = new Map<string, Set<() => void>>();
  private workspaceRevisions = new Map<string, number>();
  private panelActivations = new Map<string, number>();
  private dirtyWorkspaces = new Set<string>();
  private batchDepth = 0;
  private revision = 0;

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.revision;

  subscribeWorkspace(workspaceId: string, fn: () => void) {
    let bucket = this.workspaceListeners.get(workspaceId);
    if (!bucket) { bucket = new Set(); this.workspaceListeners.set(workspaceId, bucket); }
    bucket.add(fn);
    return () => {
      bucket.delete(fn);
      if (bucket.size === 0) this.workspaceListeners.delete(workspaceId);
    };
  }

  workspaceSnapshot(workspaceId: string) {
    return this.workspaceRevisions.get(workspaceId) ?? 0;
  }

  panelActivation(workspaceId: string, mode: PanelMode) {
    return this.panelActivations.get(`${workspaceId}:${mode}`) ?? 0;
  }

  activatePanel(workspaceId: string, mode: PanelMode) {
    const key = `${workspaceId}:${mode}`;
    const next = (this.panelActivations.get(key) ?? 0) + 1;
    remember(this.panelActivations, key, next, MAX_PANEL_ACTIVATIONS);
    this.notify(workspaceId);
  }

  private emitWorkspace(workspaceId: string) {
    const next = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    remember(this.workspaceRevisions, workspaceId, next, MAX_WORKSPACES);
    const bucket = this.workspaceListeners.get(workspaceId);
    if (bucket) for (const fn of bucket) fn();
  }

  private notify(workspaceId?: string) {
    if (!workspaceId) return;
    if (this.batchDepth > 0) {
      this.dirtyWorkspaces.add(workspaceId);
      return;
    }
    this.revision++;
    this.emitWorkspace(workspaceId);
    for (const fn of this.listeners) fn();
  }

  batch(fn: () => void) {
    this.batchDepth++;
    try { fn(); }
    finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.dirtyWorkspaces.size > 0) {
        const dirty = [...this.dirtyWorkspaces];
        this.dirtyWorkspaces.clear();
        this.revision++;
        for (const workspaceId of dirty) this.emitWorkspace(workspaceId);
        for (const listener of this.listeners) listener();
      }
    }
  }

  upsert(agent: PanelAgent) {
    const next: PanelAgent = {
      id: agent.id,
      workspaceId: agent.workspaceId,
      title: agent.title ?? null,
      archivedAt: agent.archivedAt ?? null,
    };
    const prev = this.agents.get(next.id);
    if (prev && prev.workspaceId === next.workspaceId && prev.title === next.title && prev.archivedAt === next.archivedAt) return;
    this.agents.set(next.id, next);
    if (prev?.workspaceId && prev.workspaceId !== next.workspaceId) this.notify(prev.workspaceId);
    this.notify(next.workspaceId);
  }

  remove(id: string) {
    const prev = this.agents.get(id);
    const removed = this.agents.delete(id);
    this.initialized.delete(id);
    this.initializing.delete(id);
    if (removed) this.notify(prev?.workspaceId);
  }

  selection(workspaceId: string) { return this.selected.get(workspaceId); }
  select(workspaceId: string, agentId: string) {
    if (this.selected.get(workspaceId) === agentId) return;
    remember(this.selected, workspaceId, agentId, MAX_WORKSPACES);
    this.notify(workspaceId);
  }
  hasInitialized(agentId: string) { return this.initialized.has(agentId) || this.initializing.has(agentId); }
  claim(agentId: string) {
    if (this.hasInitialized(agentId)) return false;
    this.initializing.add(agentId); return true;
  }
  complete(agentId: string) {
    this.initializing.delete(agentId);
    remember(this.initialized, agentId, true, MAX_INITIALIZED_AGENTS);
  }
  fail(agentId: string) {
    this.initializing.delete(agentId);
  }
  clear() {
    this.agents.clear(); this.selected.clear(); this.initialized.clear(); this.initializing.clear();
    this.listeners.clear(); this.workspaceListeners.clear(); this.workspaceRevisions.clear();
    this.panelActivations.clear(); this.dirtyWorkspaces.clear();
  }
}

export function WorkspaceSurface(props: PluginWorkspacePanelProps & {
  mode: PanelMode; controller: WorkspacePanels;
  openSettings: () => void; openContext: (agentId: string) => void;
}) {
  const { controller, workspaceId, theme } = props;
  const subscribe = useCallback((fn: () => void) => controller.subscribeWorkspace(workspaceId, fn), [controller, workspaceId]);
  const getSnapshot = useCallback(() => controller.workspaceSnapshot(workspaceId), [controller, workspaceId]);
  const revision = useSyncExternalStore(subscribe, getSnapshot);
  const { t } = useTranslation(messages);
  const [saved, save] = useTabState(props.tab, stateSchema, {});
  const agents = useMemo(
    () => [...controller.agents.values()].filter((a) => a.workspaceId === workspaceId && !a.archivedAt),
    [controller, workspaceId, revision],
  );
  const selected = [controller.selection(workspaceId), saved.agentId, agents[0]?.id]
    .find((id) => agents.some((agent) => agent.id === id));
  const agent = useAgent(selected ?? "", ({ id, title, workspaceId: owner }) => ({ id, title, workspaceId: owner }));
  const agentId = agent?.workspaceId === workspaceId ? agent.id : undefined;
  useEffect(() => {
    if (!agentId) return;
    if (controller.selection(workspaceId) !== agentId) controller.select(workspaceId, agentId);
    if (saved.agentId !== agentId) save({ agentId });
  }, [agentId, workspaceId, saved.agentId]);
  const activationToken = controller.panelActivation(workspaceId, props.mode);
  return <View style={{ flex: 1, minHeight: 0 }}>
    <AgentPicker agents={agents} agentId={agentId} theme={theme}
      onSelect={(value) => controller.select(workspaceId, value)} />
    {agentId ? <FrameSurface {...props} agentId={agentId} activationToken={activationToken} />
      : <Text style={{ padding: 24, color: theme.colors.foregroundMuted }}>{t("selectAgent")}</Text>}
  </View>;
}
