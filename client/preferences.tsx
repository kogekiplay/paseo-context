import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch, TextInput } from "@getpaseo/plugin/client/ui";
import { DICTS, type Translate } from "../shared/locales/i18n";
import { preferenceSchema, type Preferences } from "../shared/contracts";
import { messages } from "./messages";
import { preferencesCopy, type PreferencesCopy } from "./preferences-copy";

type State = SettingsState<typeof preferenceSchema>;
type Tab = "entries" | "display" | "prompt";
type Colors = PluginSurfaceProps["theme"]["colors"];
type PromptFields = Pick<Preferences, "promptPrefix" | "promptSuffix">;
type PromptDraft = { base: PromptFields; next: PromptFields };
const tabs = ["entries", "display", "prompt"] as const;
const palette = ["#648BFF", "#9276EF", "#34AC97", "#DE9C52"];

export function PreferencesScreen({ settings, ...props }: PluginSurfaceProps & { settings: State }) {
  return <PreferencesContent key={props.host.id} {...props} settings={settings} />;
}

function PreferencesContent({ settings, ...props }: PluginSurfaceProps & { settings: State }) {
  const { locale } = useTranslation(messages);
  const [tab, setTab] = useState<Tab>("entries");
  const [draft, setDraft] = useState<PromptDraft | null>(null);
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
  return <PreferenceForm {...props} settings={settings} copy={copy} t={t} tab={tab} setTab={setTab} draft={draft} setDraft={setDraft} />;
}

function PreferenceForm({ theme: { colors }, layout, settings, copy, t, tab, setTab, draft, setDraft }: PluginSurfaceProps & {
  settings: Extract<State, { status: "ready" }>; copy: PreferencesCopy; t: Translate;
  tab: Tab; setTab: (tab: Tab) => void; draft: PromptDraft | null; setDraft: (draft: PromptDraft | null) => void;
}) {
  const [phone, setPhone] = useState(false);
  const [wide, setWide] = useState(false);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const { values } = settings;
  const disabled = saving || settings.saving;
  const names = { entries: t("settings.group.entry"), display: t("settings.group.view"), prompt: t("settings.group.prompt") };
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
  const preview = tab !== "prompt";
  const columns = preview && !layout.compact && wide;
  return <View style={{ gap: 16, paddingVertical: 14 }} testID="context-preferences"
    onLayout={(event) => setWide(event.nativeEvent.layout.width >= 720)}>
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
      <View style={{ minWidth: 0, flex: columns ? 3 : undefined }}>
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
        <View style={{ display: tab === "prompt" ? "flex" : "none" }}>
          <PromptSettings values={values} save={save} disabled={disabled} colors={colors} copy={copy} t={t} draft={draft} setDraft={setDraft} />
        </View>
      </View>
      {preview && <View style={{ minWidth: 0, flex: columns ? 2 : undefined }}>
        <SettingsSection title={copy.preview}>
          {!layout.compact && <Segments items={[{ value: "desktop", label: copy.desktop }, { value: "phone", label: copy.phone }]}
            selected={phone ? "phone" : "desktop"} onSelect={(value) => setPhone(value === "phone")} colors={colors} />}
          <Preview tab={tab} values={values} compact={layout.compact || phone} colors={colors} copy={copy} t={t} />
        </SettingsSection>
      </View>}
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

function PromptSettings({ values, save, disabled, colors, copy, t, draft, setDraft }: {
  values: PromptFields; save: (patch: PromptFields) => Promise<boolean>; disabled: boolean; colors: Colors; copy: PreferencesCopy; t: Translate;
  draft: PromptDraft | null; setDraft: (draft: PromptDraft | null) => void;
}) {
  const base = { promptPrefix: values.promptPrefix, promptSuffix: values.promptSuffix };
  const current = draft?.next ?? base;
  const changed = current.promptPrefix !== base.promptPrefix || current.promptSuffix !== base.promptSuffix;
  const conflict = draft !== null && (draft.base.promptPrefix !== base.promptPrefix || draft.base.promptSuffix !== base.promptSuffix);
  return <SettingsSection title={t("settings.group.prompt")}>
    <Text style={{ color: colors.foregroundMuted, marginBottom: 10 }}>
      {copy.promptHint}
    </Text>
    {(["promptPrefix", "promptSuffix"] as const).map((key) => <View key={key} style={{ gap: 7, marginBottom: 12 }}>
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>{t(`settings.${key}`)}</Text>
      <TextInput multiline maxLength={100000} editable={!disabled} value={current[key]} accessibilityLabel={t(`settings.${key}`)}
        placeholder={t("settings.promptPlaceholder")} placeholderTextColor={colors.foregroundMuted}
        onChangeText={(value) => setDraft({ base: draft?.base ?? base, next: { ...current, [key]: value } })}
        style={{ color: colors.foreground, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1,
          borderRadius: 8, padding: 12, minHeight: 88, maxHeight: 240, textAlignVertical: "top" }} />
    </View>)}
    <SettingsCard>
      <SettingsAction label={t("settings.group.prompt")} actionLabel={copy.save} disabled={disabled || !changed || conflict}
        hint={conflict ? copy.conflict : undefined}
        onPress={() => { void save(current).then((ok) => { if (ok) setDraft(null); }); }} />
      {draft !== null && <SettingsAction label={copy.reloadPrompts} actionLabel={copy.reload}
        disabled={disabled} onPress={() => setDraft(null)} />}
    </SettingsCard>
  </SettingsSection>;
}

function Preview({ tab, values, compact, colors, copy, t }: { tab: Exclude<Tab, "prompt">; values: Preferences; compact: boolean; colors: Colors; copy: PreferencesCopy; t: Translate }) {
  const label = (value: string) => <Text key={value} style={{ color: colors.foreground, fontSize: 12, padding: 5 }}>{value}</Text>;
  const showTab = values.defaultPlacement === "tab" || values.defaultPlacement === "all";
  const showSidebar = values.defaultPlacement === "sidebar" || values.defaultPlacement === "all";
  const heights = values.defaultTrendMode === "delta" ? [14, 27, 19, 38, 24, 48] : [14, 22, 29, 36, 43, 52];
  const bars = values.defaultGranularity === "turn" ? [heights[1], heights[3], heights[5]] : heights;
  return <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface1,
    marginTop: 8, padding: 12, gap: 10, width: "100%", maxWidth: compact ? 300 : undefined, alignSelf: "center" }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{copy.sample}</Text>
    {tab === "entries" ? <>
      {values.insightsEntry && label(`◈ ${t("ov.title")}`)}
      <View style={{ flexDirection: "row", flexWrap: "wrap", borderBottomWidth: 1, borderBottomColor: colors.border }}>
        {label(copy.chat)}{showTab && label(copy.context)}
        {values.fleetTab && label(copy.fleet)}{label(t("stats.title"))}
      </View>
      {showSidebar && label(t("placement.sidebar") + " · " + copy.context)}
    </> : <>
      {label(t("ov.title") + " · " + t(`ov.range.${values.defaultOverviewRange}`))}
      <View accessible accessibilityLabel={t(`gran.${values.defaultTrendMode}`)} style={{ height: 58, gap: 7, flexDirection: "row", alignItems: "flex-end" }}>
        {bars.map((height, index) => <View key={index} style={{ height, flex: 1, maxWidth: 26, borderRadius: 3, backgroundColor: palette[index % palette.length] }} />)}
      </View>
      {label(t(`gran.${values.defaultGranularity}`) + " · " + t(`gran.${values.defaultTrendMode}`))}
      {values.defaultDurationCurve && label(t("settings.durationCurve"))}
    </>}
  </View>;
}
