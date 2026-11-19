import { useState, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from 'react'
import { Menu } from '../../../web/vendor/ui/index.js'
import { IconChevronDown } from '../primitives'
import { seatKeyOf, seatOf } from '../services'
import type { SettingsField, SettingsState } from '../settings'
import type { ViewKit } from '../viewkit'

interface SettingsCardProps {
  useContextSettings?: <T>(selector: (state: SettingsState) => T) => T
  set?: (field: SettingsField, value: string) => void
}

type SettingsSeat = (selector: (state: SettingsState) => SettingsState | undefined) => SettingsState | undefined

const NO_SETTINGS: SettingsSeat = () => undefined

interface PrefRowProps {
  label: string
  value: string
  options: ReadonlyArray<{ id: string; label: string }>
  disabled: boolean
  onPick: (id: string) => void
}

const MENU_ROW_HEIGHT = 34
const MENU_CHROME = 12

function roomAround(button: HTMLElement): { above: number; below: number } {
  const rect = button.getBoundingClientRect()
  let top = 0
  let bottom = window.innerHeight
  for (let node = button.parentElement; node !== null; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue
    const scrollport = node.getBoundingClientRect()
    top = scrollport.top
    bottom = scrollport.bottom
    break
  }
  return { above: rect.top - top - 4, below: bottom - rect.bottom - 4 }
}

function PrefRow(props: PrefRowProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState<'bottom' | 'top'>('bottom')
  const active = props.options.find(o => o.id === props.value)?.label ?? props.value
  const toggle = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (open) {
      setOpen(false)
      return
    }
    const room = roomAround(event.currentTarget)
    setSide(room.below < props.options.length * MENU_ROW_HEIGHT + MENU_CHROME && room.above > room.below ? 'top' : 'bottom')
    setOpen(true)
  }
  return (
    <div className="lc-settings-row">
      <span className="lc-settings-label">{props.label}</span>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={props.options}
        selectedId={props.value}
        onSelect={(id) => { setOpen(false); props.onPick(id) }}
        align="end"
        side={side}
        anchor={(
          <button
            type="button"
            className="lc-settings-select hover:enabled:bg-(--dsw-alias-interactive-bg-hover) disabled:opacity-50 disabled:cursor-default"
            disabled={props.disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          >
            {active}
            <IconChevronDown />
          </button>
        )}
      />
    </div>
  )
}

type Translate = ViewKit['t']

function ShowHideRow(props: { t: Translate; label: string; value: string; disabled: boolean; onPick: (id: string) => void }): ReactElement {
  return (
    <PrefRow
      label={props.label}
      value={props.value}
      disabled={props.disabled}
      options={[
        { id: 'show', label: props.t('showHide.show') },
        { id: 'hide', label: props.t('showHide.hide') },
      ]}
      onPick={props.onPick}
    />
  )
}

function Group(props: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="lc-settings-group" role="group" aria-label={props.title}>
      <div className="lc-settings-group-title">{props.title}</div>
      {props.children}
    </div>
  )
}

function PreferenceRows(props: { t: Translate; state: SettingsState; set?: SettingsCardProps['set'] }): ReactElement {
  const { t, state, set } = props
  const disabled = state.status !== 'ready' || !state.writable
  return (
    <>
      <Group title={t('settings.group.entry')}>
        <PrefRow
          label={t('settings.placement')}
          value={state.placement}
          disabled={disabled}
          options={[
            { id: 'all', label: t('placement.all') },
            { id: 'tab', label: t('placement.tab') },
            { id: 'sidebar', label: t('placement.sidebar') },
            { id: 'hide', label: t('placement.hide') },
          ]}
          onPick={(id) => { set?.('defaultPlacement', id) }}
        />
        <ShowHideRow t={t} label={t('settings.insightsEntry')} value={state.insightsEntry} disabled={disabled}
          onPick={(id) => { set?.('insightsEntry', id) }} />
        <ShowHideRow t={t} label={t('settings.fleetTab')} value={state.fleetTab} disabled={disabled}
          onPick={(id) => { set?.('fleetTab', id) }} />
      </Group>
      <Group title={t('settings.group.view')}>
        <PrefRow
          label={t('settings.overviewRange')}
          value={state.overviewRange}
          disabled={disabled}
          options={[
            { id: 'today', label: t('ov.range.today') },
            { id: '7d', label: t('ov.range.7d') },
            { id: '30d', label: t('ov.range.30d') },
          ]}
          onPick={(id) => { set?.('defaultOverviewRange', id) }}
        />
        <PrefRow
          label={t('settings.gran')}
          value={state.granularity}
          disabled={disabled}
          options={[
            { id: 'step', label: t('gran.step') },
            { id: 'turn', label: t('gran.turn') },
          ]}
          onPick={(id) => { set?.('defaultGranularity', id) }}
        />
        <PrefRow
          label={t('settings.mode')}
          value={state.mode}
          disabled={disabled}
          options={[
            { id: 'total', label: t('gran.total') },
            { id: 'delta', label: t('gran.delta') },
          ]}
          onPick={(id) => { set?.('defaultTrendMode', id) }}
        />
        <ShowHideRow t={t} label={t('settings.durationCurve')} value={state.durationCurve} disabled={disabled}
          onPick={(id) => { set?.('defaultDurationCurve', id) }} />
        <PrefRow
          label={t('settings.overviewAuto')}
          value={state.overviewAutoSteps}
          disabled={disabled}
          options={[
            { id: '100', label: t('settings.overviewAutoSteps', { n: 100 }) },
            { id: '200', label: t('settings.overviewAutoSteps', { n: 200 }) },
            { id: '300', label: t('settings.overviewAutoSteps', { n: 300 }) },
            { id: 'off', label: t('settings.overviewAutoOff') },
          ]}
          onPick={(id) => { set?.('overviewAutoSteps', id) }}
        />
        <PrefRow
          label={t('settings.deltaBase')}
          value={state.deltaBase}
          disabled={disabled}
          options={[
            { id: 'step', label: t('browser.base.step') },
            { id: 'turn', label: t('browser.base.turn') },
          ]}
          onPick={(id) => { set?.('defaultDeltaBase', id) }}
        />
        <PrefRow
          label={t('settings.toolSort')}
          value={state.toolSort}
          disabled={disabled}
          options={[
            { id: 'size', label: t('tool.sort.size') },
            { id: 'count', label: t('tool.sort.count') },
            { id: 'name', label: t('tool.sort.name') },
          ]}
          onPick={(id) => { set?.('defaultToolSort', id) }}
        />
        <PrefRow
          label={t('settings.fileSort')}
          value={state.fileSort}
          disabled={disabled}
          options={[
            { id: 'count', label: t('files.sort.count') },
            { id: 'lines', label: t('files.sort.lines') },
            { id: 'latest', label: t('files.sort.latest') },
            { id: 'path', label: t('files.sort.path') },
            { id: 'name', label: t('files.sort.name') },
          ]}
          onPick={(id) => { set?.('defaultFileSort', id) }}
        />
      </Group>
    </>
  )
}

export function makePluginConfigCard(kit: ViewKit): (props: SettingsCardProps) => ReactElement | null {
  const { t } = kit
  return function PluginConfigCard(props: SettingsCardProps): ReactElement | null {
    return <PluginConfigCardBody key={seatKeyOf(props)} {...props} />
  }
  function PluginConfigCardBody(props: SettingsCardProps): ReactElement | null {
    const read = seatOf<SettingsSeat>(props.useContextSettings, NO_SETTINGS)
    const state = read(s => s)
    if (state === undefined || state.status === 'unavailable') return null
    return (
      <div className="lc-settings-prefs">
        {!state.writable && state.status === 'ready'
          ? <p className="lc-settings-note" role="status">{t('settings.readOnly')}</p>
          : null}
        <PreferenceRows t={t} state={state} set={props.set} />
      </div>
    )
  }
}
