import { act, create } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { preferenceSchema, type Preferences } from "../shared/contracts";

const mocks = vi.hoisted(() => ({
  locale: "zh-CN",
  frame: vi.fn(() => null),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useTranslation: () => ({ locale: mocks.locale, t: (k: string) => k }),
  defineTranslations: (value: unknown) => value,
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsAction: "SettingsAction",
  SettingsCard: "SettingsCard",
  SettingsSection: "SettingsSection",
  SettingsSelect: "SettingsSelect",
  SettingsSwitch: "SettingsSwitch",
}));
vi.mock("../client/frame", () => ({ FrameSurface: mocks.frame }));

import { PreferencesScreen } from "../client/preferences";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReturnType<typeof create> | null = null;

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = null;
  mocks.locale = "zh-CN";
  vi.clearAllMocks();
});

const surfaceProps = {
  host: { id: "host-1", label: "Host" },
  layout: { compact: false, platform: "web" as const },
  theme: {
    colors: {
      surface0: "#ffffff",
      surface1: "#f3f4f6",
      foreground: "#111111",
      foregroundMuted: "#666666",
      border: "#e5e7eb",
      statusDanger: "#dc2626",
    },
  },
};

function makeReadySettings(overrides: Partial<Preferences> = {}, extra: Record<string, unknown> = {}) {
  return {
    status: "ready" as const,
    revision: "rev-1",
    saving: false,
    saveError: undefined as string | undefined,
    values: preferenceSchema.parse(overrides),
    save: vi.fn(async () => true),
    reload: vi.fn(async () => {}),
    ...extra,
  };
}

describe("PreferencesScreen", () => {
  test("renders loading and error states with reload action", async () => {
    const reload = vi.fn(async () => {});
    await act(async () => {
      renderer = create(createElement(PreferencesScreen, {
        ...surfaceProps,
        settings: { status: "loading", reload } as any,
      } as any));
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("正在载入设置");

    await act(async () => {
      renderer!.update(createElement(PreferencesScreen, {
        ...surfaceProps,
        settings: { status: "error", error: "Host offline", reload } as any,
      } as any));
    });
    const action = renderer!.root.findByType("SettingsAction" as any);
    expect(action.props.actionLabel).toBe("重试");
    await act(async () => action.props.onPress());
    expect(reload).toHaveBeenCalledOnce();
  });

  test("switches groups, toggles desktop/phone preview, and serializes saves with rejection recovery", async () => {
    let finishSave!: (ok: boolean) => void;
    const settings = makeReadySettings({}, {
      save: vi.fn(() => new Promise<boolean>((resolve) => { finishSave = resolve; })),
    });
    await act(async () => {
      renderer = create(createElement(PreferencesScreen, { ...surfaceProps, settings } as any));
    });

    // Switch from Entries tab to View Defaults tab.
    const tabs = renderer!.root.findAllByProps({ accessibilityRole: "tab" });
    expect(tabs.map((tab) => tab.findByType("Text" as any).children.join(""))).toContain("视图默认值");
    await act(async () => tabs[1].props.onPress());
    expect(renderer!.root.findAllByType("SettingsSelect" as any).length).toBeGreaterThanOrEqual(6);

    // Toggle Phone preview width.
    const phoneTab = renderer!.root.findAllByProps({ accessibilityRole: "tab" })
      .find((tab) => tab.findByType("Text" as any).children.join("") === "手机")!;
    await act(async () => phoneTab.props.onPress());
    expect(mocks.frame).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "context" }), undefined);

    // Concurrent save while first save is in flight is blocked by lock.
    const switchControl = renderer!.root.findByType("SettingsSwitch" as any);
    await act(async () => {
      switchControl.props.onValueChange(false);
      switchControl.props.onValueChange(true);
    });
    expect(settings.save).toHaveBeenCalledTimes(1);
    await act(async () => { finishSave(true); await Promise.resolve(); });

    // Rejected save surfaces error alert cleanly without unhandled rejection.
    settings.save.mockRejectedValueOnce(new Error("Write conflict"));
    await act(async () => { switchControl.props.onValueChange(false); await Promise.resolve(); });
    const alert = renderer!.root.findByProps({ accessibilityRole: "alert" });
    expect(JSON.stringify(alert.findAllByType("Text" as any).map((t) => t.children))).toContain("Write conflict");
    await act(async () => alert.findByType("Pressable" as any).props.onPress());
    expect(settings.reload).toHaveBeenCalledOnce();
  });
});
