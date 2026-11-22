import type { FrameProps } from "./frame";
import { uiRevision } from "../shared/generated/ui-revision";

export type BridgeRpcFn = (input: { route: string; payload: unknown }) => Promise<unknown>;

export interface SettingsStateLike<T extends Record<string, unknown>> {
  status: string;
  revision?: string;
  values?: T;
  save?: (values: T, revision?: string) => Promise<boolean>;
}

export function originalPreferences(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) =>
    [key, typeof value === "boolean" ? value ? "show" : "hide" : value]));
}

/** Parse 3/4/6/8-digit hex or rgb()/rgba() CSS colors to decide dark mode. */
export function isDarkColor(color: string): boolean {
  const trimmed = color.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const rgb = [0, 1, 2].map((i) => parseInt(hex[i] + hex[i], 16));
      return rgb.every(Number.isFinite) && (rgb[0] + rgb[1] + rgb[2]) / 3 < 128;
    }
    if (hex.length === 6 || hex.length === 8) {
      const rgb = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
      return rgb.every(Number.isFinite) && (rgb[0] + rgb[1] + rgb[2]) / 3 < 128;
    }
    return false;
  }
  const match = /^rgba?\(\s*([0-9.]+%?)\s*[,\s]\s*([0-9.]+%?)\s*[,\s]\s*([0-9.]+%?)(?:\s*[,/]\s*[0-9.]+%?)?\s*\)$/i.exec(trimmed);
  if (!match) return false;
  const rgb = match.slice(1, 4).map((part) => part.endsWith("%") ? parseFloat(part) * 2.55 : parseFloat(part));
  return rgb.every(Number.isFinite) && (rgb[0] + rgb[1] + rgb[2]) / 3 < 128;
}

export function platformNameOf(os: string, hint = ""): string {
  if (os === "macos") return "darwin";
  if (os === "windows") return "win32";
  if (os === "web") {
    if (/mac/i.test(hint)) return "darwin";
    if (/win/i.test(hint)) return "win32";
    if (/linux/i.test(hint)) return "linux";
    return "web";
  }
  return os || "web";
}

export function uiDocumentQueryOptions(rpc: BridgeRpcFn) {
  return {
    queryKey: ["paseo-context", "ui.document", uiRevision] as const,
    staleTime: Infinity,
    gcTime: 120000,
    queryFn: async () => {
      const value = await rpc({ route: "ui.document", payload: {} });
      if (typeof value !== "string") throw new Error("Invalid UI document");
      return value;
    },
  };
}

export function buildInitPayload(
  props: FrameProps,
  values: Record<string, unknown>,
  nonce: string,
  locale: string,
  platform: string,
) {
  return {
    type: "paseo-context:init" as const,
    nonce,
    agentId: props.agentId ?? "",
    mode: props.mode,
    locale,
    platform,
    preferences: originalPreferences(values),
    preview: !!props.preview,
    dark: isDarkColor(props.theme.colors.surface0),
  };
}

export function createSettingsSaver<T extends Record<string, unknown>>(getLatest: () => SettingsStateLike<T>) {
  let queue: Promise<unknown> = Promise.resolve();
  return (field: string, rawValue: unknown): Promise<Record<string, unknown>> => {
    const run = queue.then(async () => {
      const current = getLatest();
      if (current.status !== "ready" || !current.values || !current.save) {
        throw new Error("Preferences are not ready");
      }
      if (!Object.hasOwn(current.values, field)) throw new Error("Unknown preference");
      const value = typeof current.values[field] === "boolean" ? rawValue === "show" : rawValue;
      const next = { ...current.values, [field]: value } as T;
      if (!await current.save(next, current.revision)) {
        throw new Error("Could not save preferences; reload and retry");
      }
      return originalPreferences(next);
    });
    queue = run.catch(() => {});
    return run;
  };
}

export function handleBridgeAction(
  data: { name?: unknown; payload?: any },
  props: FrameProps,
  openExternal: (url: string) => void,
) {
  if (props.preview) {
    if (data.name === "openAgent") props.preview.onSelectAgent(String(data.payload?.agentId ?? ""));
    if (data.name === "previewPage") props.preview.onSelectPage(data.payload?.mode);
    return;
  }
  if (data.name === "openAgent") {
    const id = String(data.payload?.agentId ?? "");
    if (id.startsWith("native:")) props.openContext(id);
    else props.navigation?.openAgent({ agentId: id });
  } else if (data.name === "openSettings") {
    props.openSettings();
  } else if (data.name === "close") {
    props.onClose?.();
  } else if (data.name === "openExternal") {
    const url = String(data.payload?.url ?? "");
    if (/^https?:\/\//.test(url)) openExternal(url);
  }
}

export async function handleBridgeRpc(
  data: { route?: unknown; payload?: any },
  deps: {
    props: FrameProps;
    rpc: BridgeRpcFn;
    previewRpc: BridgeRpcFn;
    saveSetting: (field: string, value: unknown) => Promise<Record<string, unknown>>;
    copyText: (text: string) => Promise<void>;
  },
): Promise<unknown> {
  const route = String(data.route ?? "");
  if (route === "clipboard.write") {
    await deps.copyText(String(data.payload?.text ?? ""));
    return true;
  }
  if (deps.props.preview) {
    return deps.previewRpc({ route, payload: data.payload });
  }
  if (route === "settings.set") {
    return deps.saveSetting(String(data.payload?.field ?? ""), data.payload?.value);
  }
  return deps.rpc({ route, payload: data.payload });
}
