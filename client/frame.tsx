import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { WebFrame } from "./web";
import { NativeFrame } from "./native";

export function FrameSurface(props: PluginSurfaceProps & {
  mode: "context" | "fleet" | "insights" | "settings" | "modal";
  agentId?: string; overlay?: boolean; onClose?: () => void;
  openSettings: () => void; openContext: (agentId: string) => void;
}) {
  return Platform.OS === "web" ? <WebFrame {...props} /> : <NativeFrame {...props} />;
}
