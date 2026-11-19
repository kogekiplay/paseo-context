import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { DICTS, type Translate } from "../shared/locales/i18n";
import { preferenceSchema, type Preferences } from "../shared/contracts";
import { messages } from "./messages";
import { preferencesCopy, type PreferencesCopy } from "./preferences-copy";
import { previewAgentId } from "../shared/bridge";
import { FrameSurface } from "./frame";

type State = SettingsState<typeof preferenceSchema>;
type Tab = "entries" | "display";
type Colors = PluginSurfaceProps["theme"]["colors"];
const tabs = ["entries", "display"] as const;

export function PreferencesScreen({ settings, ...props }: PluginSurfaceProps & { settings: State }) {
  return <PreferencesContent key={props.host.id} {...props} settings={settings} />;
}

function PreferencesContent({ settings, ...props }: PluginSurfaceProps & { settings: State }) {
  const { locale } = useTranslation(messages);
  const [tab, setTab] = useState<Tab>("entries");
  const language = locale.toLowerCase().split("-")[0] as keyof typeof DICTS;
  const copy = preferencesCopy[language] ?? preferencesCopy.en;
  const dictionary: Record<string, string> = DICTS[language] ?? DICTS.en;
  const t: Translate = (key, params) => (dictionary[key] ?? (DICTS.en as Record<string, string>)[key] ?? key)
    .replace(/\{(\w+)\}/g, (match, name) => String(params?.[name] ?? match));
  if (settings.status === "loading") return <Text style={{ color: props.theme.colors.foregroundMuted }}>{copy.loading}</Text>;
  if (settings.status !== "ready") return <SettingsSection title={copy.unavailable}>
    <SettingsCard><SettingsAction label={copy.reload}
      hint={settings.error} actionLabel={t("error.retry")} onPress={() => { void settings.reload().catch(() => {}); }} /></SettingsCard>
  </SettingsSection>;
  return <PreferenceForm {...props} settings={settings} copy={copy} t={t} tab={tab} setTab={setTab} />;
}

function PreferenceForm({ settings, copy, t, tab, setTab, ...props }: PluginSurfaceProps & {
  settings: Extract<State, { status: "ready" }>; copy: PreferencesCopy; t: Translate;
  tab: Tab; setTab: (tab: Tab) => void;
}) {
  const { theme: { colors }, layout } = props;
  const [phone, setPhone] = useState(false);
  const [wide, setWide] = useState(false);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const { values } = settings;
  const disabled = saving || settings.saving;
  const names = { entries: t("settings.group.entry"), display: t("settings.group.view") };
  async function save(patch: Partial<Preferences>) {
    if (lock.current || settings.saving) return false;
    lock.current = true;
    setSaving(true);
    try { return await settings.save({ ...settings.values, ...patch }, settings.revision); }
    finally { lock.current = false; setSaving(false); }
  }
  const options = <Value extends string>(choices: Array<[Value, string]>) => choices.map(([value, key]) => ({ value, label: t(key) }));
  const granularity = options([["step", "gran.step"], ["turn", "gran.turn"]]);
  const select = <Key extends keyof Preferences,>(key: Key, label: string, choices: readonly { value: Extract<Preferences[Key], string>; label: string }[]) =>
    <SettingsSelect label={t(label)} value={values[key] as Extract<Preferences[Key], string>} options={choices}
      disabled={disabled} onValueChange={(value) => { void save({ [key]: value }); }} />;
  const toggle = (key: "insightsEntry" | "fleetTab" | "defaultDurationCurve", label: string) =>
    <SettingsSwitch label={t(label)} value={values[key]} disabled={disabled} onValueChange={(value) => { void save({ [key]: value }); }} />;
  const columns = !layout.compact && wide;
  return <View style={{ gap: 16, paddingVertical: 14 }} testID="context-preferences"
    onLayout={(event) => setWide(event.nativeEvent.layout.width >= 1080)}>
    <Segments items={tabs.map((value) => ({ value, label: names[value] }))} selected={tab} onSelect={setTab} colors={colors} />
    <Text style={{ fontSize: 13, color: colors.foregroundMuted }}>
      {copy.shared}
    </Text>
    {settings.saveError ? <View accessibilityRole="alert" style={{ gap: 6 }}>
      <Text style={{ color: colors.statusDanger }}>{settings.saveError}</Text>
      <Pressable accessibilityRole="button" onPress={() => { void settings.reload().catch(() => {}); }}>
        <Text style={{ color: colors.foreground }}>{copy.reload}</Text>
      </Pressable>
    </View> : null}
    <View style={{ flexDirection: columns ? "row" : "column", alignItems: columns ? "flex-start" : "stretch", gap: 20 }}>
      <View style={{ minWidth: 0, flex: columns ? 2 : undefined }}>
        {tab === "entries" && <SettingsSection title={names.entries}><SettingsCard>
          {select("defaultPlacement", "settings.placement", options([["all", "placement.all"], ["tab", "placement.tab"], ["sidebar", "placement.sidebar"], ["hide", "placement.hide"]]))}
          {toggle("insightsEntry", "settings.insightsEntry")}
          {toggle("fleetTab", "settings.fleetTab")}
        </SettingsCard></SettingsSection>}
        {tab === "display" && <SettingsSection title={names.display}><SettingsCard>
          {select("defaultOverviewRange", "settings.overviewRange", options([["today", "ov.range.today"], ["7d", "ov.range.7d"], ["30d", "ov.range.30d"]]))}
          {select("defaultGranularity", "settings.gran", granularity)}
          {select("defaultTrendMode", "settings.mode", options([["total", "gran.total"], ["delta", "gran.delta"]]))}
          {toggle("defaultDurationCurve", "settings.durationCurve")}
          {select("overviewAutoSteps", "settings.overviewAuto", [{ value: "off", label: t("settings.overviewAutoOff") },
            ...(["100", "200", "300"] as const).map((value) => ({ value, label: t("settings.overviewAutoSteps", { n: value }) }))])}
          {select("defaultDeltaBase", "settings.deltaBase", options([["step", "browser.base.step"], ["turn", "browser.base.turn"]]))}
          {select("defaultToolSort", "settings.toolSort", options([["size", "tool.sort.size"], ["count", "tool.sort.count"], ["name", "tool.sort.name"]]))}
          {select("defaultFileSort", "settings.fileSort", options([["count", "files.sort.count"], ["lines", "files.sort.lines"], ["latest", "files.sort.latest"], ["path", "files.sort.path"], ["name", "files.sort.name"]]))}
        </SettingsCard></SettingsSection>}
      </View>
      <View style={{ minWidth: 0, flex: columns ? 3 : undefined }}>
        <SettingsSection title={copy.preview}>
          {!layout.compact && <Segments items={[{ value: "desktop", label: copy.desktop }, { value: "phone", label: copy.phone }]}
            selected={phone ? "phone" : "desktop"} onSelect={(value) => setPhone(value === "phone")} colors={colors} />}
          <Preview {...props} values={values} compact={layout.compact || phone} copy={copy} t={t} />
        </SettingsSection>
      </View>
    </View>
  </View>;
}

function Segments<Value extends string>({ items, selected, onSelect, colors }: {
  items: readonly { value: Value; label: string }[]; selected: Value; onSelect: (value: Value) => void; colors: Colors;
}) {
  return <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", alignSelf: "flex-start", gap: 3,
    padding: 3, borderRadius: 9, backgroundColor: colors.surface1, marginBottom: 3 }}>
    {items.map(({ value, label }) => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: value === selected }}
      onPress={() => onSelect(value)} style={{ paddingVertical: 8, paddingHorizontal: 11, borderRadius: 7,
        backgroundColor: value === selected ? colors.surface0 : colors.surface1 }}>
      <Text style={{ color: value === selected ? colors.foreground : colors.foregroundMuted, fontWeight: value === selected ? "600" : "400" }}>{label}</Text>
    </Pressable>)}
  </View>;
}

type PreviewPage = "context" | "sidebar-context" | "fleet" | "statistics" | "insights";
const ignore = () => {};

function Preview({ values, compact, copy, t, ...props }: PluginSurfaceProps & { values: Preferences; compact: boolean; copy: PreferencesCopy; t: Translate }) {
  const { colors } = props.theme;
  const contextPage = values.defaultPlacement === "hide" ? null : values.defaultPlacement === "sidebar" ? "sidebar-context" : "context";
  const pages: { value: PreviewPage; label: string }[] = [
    ...(contextPage === "context" ? [{ value: "context" as const, label: copy.context }] : []),
    ...(values.fleetTab ? [{ value: "fleet" as const, label: copy.fleet }] : []),
    { value: "statistics", label: t("stats.title") },
    ...(values.insightsEntry ? [{ value: "insights" as const, label: t("ov.title") }] : []),
    ...(values.defaultPlacement === "all" || values.defaultPlacement === "sidebar" ? [{ value: "sidebar-context" as const, label: `${t("placement.sidebar")} · ${copy.context}` }] : []),
  ];
  const [page, setPage] = useState<PreviewPage>(contextPage ?? "statistics");
  const [agentId, setAgentId] = useState(previewAgentId);
  const selected = pages.some(({ value }) => value === page) ? page : contextPage ?? "statistics";
  const previous = useRef(values);
  useEffect(() => {
    const before = previous.current;
    previous.current = values;
    if (before.defaultOverviewRange !== values.defaultOverviewRange && values.insightsEntry) setPage("insights");
    else if (contextPage && (before.defaultPlacement !== values.defaultPlacement || before.defaultGranularity !== values.defaultGranularity
      || before.defaultTrendMode !== values.defaultTrendMode || before.defaultDurationCurve !== values.defaultDurationCurve
      || before.overviewAutoSteps !== values.overviewAutoSteps || before.defaultDeltaBase !== values.defaultDeltaBase
      || before.defaultToolSort !== values.defaultToolSort || before.defaultFileSort !== values.defaultFileSort)) setPage(contextPage);
    else if (page !== selected) setPage(selected);
  }, [values, contextPage, page, selected]);
  return <View style={{ width: "100%", maxWidth: compact ? 390 : undefined, alignSelf: "center", marginTop: 6, gap: 6 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{copy.sample}</Text>
    <Segments items={pages} selected={selected} onSelect={(next) => { setPage(next); setAgentId(previewAgentId); }} colors={colors} />
    <View style={{ width: "100%", maxWidth: selected === "sidebar-context" ? 420 : undefined, alignSelf: "center",
      height: compact ? 480 : 540, borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: "hidden", backgroundColor: colors.surface0 }}>
      <FrameSurface {...props} mode={selected} agentId={agentId}
        openSettings={ignore} openContext={ignore} preview={{ values, onSelectAgent: (id) => {
          if (!id.startsWith("preview-")) return;
          setAgentId(id); setPage(contextPage ?? "statistics");
        }, onSelectPage: (mode) => {
          if (mode === "fleet" && values.fleetTab) setPage("fleet");
          if (mode === "context" && contextPage) setPage(contextPage);
        } }} />
    </View>
  </View>;
}
