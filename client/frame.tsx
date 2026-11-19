import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { WebFrame } from "./web";
import { NativeFrame } from "./native";
import type { Preferences } from "../shared/contracts";

export type FrameProps = PluginSurfaceProps & {
  mode: "context" | "sidebar-context" | "fleet" | "statistics" | "insights" | "settings" | "modal";
  agentId?: string; overlay?: boolean; onClose?: () => void;
  openSettings: () => void; openContext: (agentId: string) => void;
  preview?: { values: Preferences; onSelectAgent: (id: string) => void; onSelectPage: (mode: unknown) => void };
};

export function FrameSurface(props: FrameProps) {
  return Platform.OS === "web" ? <WebFrame {...props} /> : <NativeFrame {...props} />;
}
