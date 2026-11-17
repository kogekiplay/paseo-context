import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { messages } from "./messages";
import type { PanelAgent } from "./workspace";

export function AgentPicker({ agents, agentId, onSelect, theme }: {
  agents: PanelAgent[]; agentId?: string; onSelect: (id: string) => void;
  theme: PluginSurfaceProps["theme"];
}) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation(messages);
  if (agents.length < 2) return null;
  const selected = agents.find((agent) => agent.id === agentId);
  const title = selected?.title || selected?.id || t("selectAgent");
  return <>
    <View style={{ alignItems: "flex-end", paddingHorizontal: 12, paddingVertical: 3, backgroundColor: theme.colors.surface0 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${t("agent")}: ${title}`}
        onPress={() => setOpen(true)}
        style={{ flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "100%", paddingHorizontal: 6, paddingVertical: 3 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>{title}</Text>
        <Icon name="ChevronDown" size={12} color={theme.colors.foregroundMuted} />
      </Pressable>
    </View>
    <Modal title={t("agent")} open={open} onOpenChange={setOpen}>
      <Modal.Content>
        {agents.map((agent) => <Pressable key={agent.id} accessibilityRole="button"
          accessibilityLabel={agent.title || agent.id} accessibilityState={{ selected: agent.id === agentId }}
          onPress={() => { onSelect(agent.id); setOpen(false); }}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10 }}>
          <Text style={{ flex: 1, color: theme.colors.foreground }}>{agent.title || agent.id}</Text>
          {agent.id === agentId && <Icon name="Check" size={16} color={theme.colors.foreground} />}
        </Pressable>)}
      </Modal.Content>
    </Modal>
  </>;
}
