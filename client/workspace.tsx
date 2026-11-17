import { useEffect, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useAgent, useTabState, useTranslation, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { FrameSurface } from "./frame";
import { messages } from "./messages";

export type PanelMode = "context" | "fleet" | "statistics";
export interface PanelAgent { id: string; workspaceId?: string; title?: string | null; archivedAt?: string | null }
const stateSchema = z.object({ agentId: z.string().optional() });
const MAX_WORKSPACES = 128, MAX_INITIALIZED_AGENTS = 512;
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
  private revision = 0;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.revision;
  private publish() { this.revision++; for (const fn of this.listeners) fn(); }
  upsert(agent: PanelAgent) { this.agents.set(agent.id, agent); this.publish(); }
  remove(id: string) { this.agents.delete(id); this.initialized.delete(id); this.initializing.delete(id); this.publish(); }
  selection(workspaceId: string) { return this.selected.get(workspaceId); }
  select(workspaceId: string, agentId: string) {
    if (this.selected.get(workspaceId) === agentId) return;
    remember(this.selected, workspaceId, agentId, MAX_WORKSPACES); this.publish();
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
    this.agents.clear(); this.selected.clear(); this.initialized.clear(); this.initializing.clear(); this.listeners.clear();
  }
}

export function WorkspaceSurface(props: PluginWorkspacePanelProps & {
  mode: PanelMode; controller: WorkspacePanels;
  openSettings: () => void; openContext: (agentId: string) => void;
}) {
  const { controller, workspaceId, theme } = props;
  useSyncExternalStore(controller.subscribe, controller.snapshot);
  const { t } = useTranslation(messages);
  const [saved, save] = useTabState(props.tab, stateSchema, {});
  const agents = [...controller.agents.values()].filter((a) => a.workspaceId === workspaceId && !a.archivedAt);
  const selected = [controller.selection(workspaceId), saved.agentId, agents[0]?.id]
    .find((id) => agents.some((agent) => agent.id === id));
  const agent = useAgent(selected ?? "", ({ id, title, workspaceId: owner }) => ({ id, title, workspaceId: owner }));
  const agentId = agent?.workspaceId === workspaceId ? agent.id : undefined;
  useEffect(() => {
    if (!agentId) return;
    controller.select(workspaceId, agentId);
    if (saved.agentId !== agentId) save({ agentId });
  }, [agentId, workspaceId, saved.agentId]);
  return <View style={{ flex: 1, minHeight: 0 }}>
    <View style={{ paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>
      <SettingsSelect label={t("agent")} value={agentId ?? ""}
        options={agents.map((a) => ({ value: a.id, label: a.title || a.id }))}
        onValueChange={(value) => controller.select(workspaceId, value)} />
    </View>
    {agentId ? <FrameSurface {...props} agentId={agentId} />
      : <Text style={{ padding: 24, color: theme.colors.foregroundMuted }}>{t("selectAgent")}</Text>}
  </View>;
}
