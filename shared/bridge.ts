import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const input = z.object({ route: z.string().min(1).max(200), payload: z.unknown() });
export const bridgeRpc = defineRpc({ name: "context.ui", input, output: z.unknown() });
export const settingsPreviewRpc = defineRpc({ name: "context.settings-preview", input, output: z.unknown() });
export const previewAgentId = "preview-atlas";
