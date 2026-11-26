import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { balanceEntryOf, peekPlatformBalances, subscribePlatformBalances } from '../balance'
import { IconCheck, IconChevronDown } from '../primitives'
import type { BalanceSource, PlatformBalanceEntry, PlatformBalances } from '../../shared/types'
import type { ContextSettings } from '../settings'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'
import { useAnchoredPanel } from './anchoredPanel'
import { useEscapeClose } from './escapeClose'

const USAGE_URL = 'https://platform.deepseek.com/usage'

const PANEL_ID = 'lc-bal-panel'

const SOURCES: readonly BalanceSource[] = ['account', 'api']

const LABELS: Record<BalanceSource, string> = {
  account: 'balance.account',
  api: 'balance.api',
}

const ROWS = [
  ['balance.total', 'total'],
  ['balance.toppedUp', 'toppedUp'],
  ['balance.granted', 'granted'],
] as const

function symbolOf(currency: string): string {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return currency + ' '
}

function money(amount: number, currency: string): string {
  return symbolOf(currency) + amount.toFixed(2)
}

interface SourceRow {
  source: BalanceSource
  entry: PlatformBalanceEntry
}

export function makeBalanceCapsule(ctx: ClientCtx, kit: ViewKit, settings: ContextSettings): () => ReactElement | null {
  const { t } = kit
  const subscribeSettings = settings.store.subscribe.bind(settings.store)
  return function BalanceCapsule(): ReactElement | null {
    const [balances, setBalances] = useState<PlatformBalances | null>(() => peekPlatformBalances())
    const settingsState = useSyncExternalStore(subscribeSettings, () => settings.store.getSnapshot())
    const configured = settingsState.balanceSource
    const writable = settingsState.status === 'ready' && settingsState.writable
    const [picked, setPicked] = useState<BalanceSource | null>(null)
    const [open, setOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const panelRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => subscribePlatformBalances((v) => { setBalances(v) }), [])
    useEffect(() => { setPicked(null) }, [configured])

    const locale = ctx.locale
    const active = typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
    const currency = active === 'zh' ? 'cny' : 'usd'
    const rows: SourceRow[] = []
    for (const source of SOURCES) {
      const entry = balanceEntryOf(balances?.[source] ?? null, currency)
      if (entry !== null) rows.push({ source, entry })
    }

    const panelOpen = open && rows.length > 0
    const closeDismiss = (): void => { setOpen(false) }
    const closeWithFocus = (): void => {
      setOpen(false)
      triggerRef.current?.focus()
    }
    useEscapeClose(panelOpen, closeWithFocus, false)
    const spot = useAnchoredPanel(panelOpen, triggerRef, panelRef, closeDismiss)
    const measured = spot !== null
    useEffect(() => {
      if (open && rows.length === 0) setOpen(false)
    }, [open, rows.length])
    useEffect(() => {
      if (!panelOpen || !measured) return
      panelRef.current?.focus()
    }, [panelOpen, measured])

    if (rows.length === 0) return null
    const preferred = writable ? configured : (picked ?? configured)
    const current = rows.find(row => row.source === preferred) ?? rows[0]

    const select = (next: BalanceSource): void => {
      setOpen(false)
      triggerRef.current?.focus()
      if (writable) {
        setPicked(null)
        settings.set('balanceSource', next)
      } else {
        setPicked(next)
      }
    }

    const toggle = (): void => {
      if (panelOpen) {
        setOpen(false)
        return
      }
      setOpen(true)
    }

    return (
      <div className="lc-bal">
        <button
          ref={triggerRef}
          type="button"
          className="lc-ov-balance"
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          aria-controls={panelOpen ? PANEL_ID : undefined}
          onClick={toggle}
        >
          {rows.length > 1
            ? <IconChevronDown className={'lc-ov-balance-caret' + (panelOpen ? ' lc-ov-balance-caret-open' : '')} size={12} />
            : null}
          <span className="lc-ov-balance-label">{t(LABELS[current.source])}</span>
          <span className="lc-ov-balance-value">{money(current.entry.total, current.entry.currency)}</span>
        </button>
        {panelOpen ? createPortal(
          <div
            ref={panelRef}
            id={PANEL_ID}
            tabIndex={-1}
            className="lc-tip lc-bal-panel"
            role="dialog"
            aria-label={t('balance.title')}
            style={spot === null ? { left: 0, top: 0, visibility: 'hidden' } : { left: spot.left, top: spot.top }}
          >
            {rows.map(({ source, entry }) => (
              <button
                key={source}
                type="button"
                className={'lc-bal-option' + (source === current.source ? ' lc-bal-option-on' : '')}
                aria-pressed={source === current.source}
                onClick={() => { select(source) }}
              >
                <span className="lc-bal-option-head">
                  <span className="lc-bal-option-name">{t(LABELS[source])}</span>
                  {source === current.source ? <IconCheck className="lc-bal-option-check" size={12} /> : null}
                </span>
                <span className="lc-bal-rows">
                  {ROWS.map(([label, field]) => (
                    <span key={label} className="lc-bal-row">
                      <span className="lc-bal-row-label">{t(label)}</span>
                      <span className="lc-bal-row-value">{money(entry[field], entry.currency)}</span>
                    </span>
                  ))}
                </span>
              </button>
            ))}
            <a className="lc-bal-usage" href={USAGE_URL} target="_blank" rel="noreferrer">{t('balance.usage')}</a>
          </div>,
          document.body,
        ) : null}
      </div>
    )
  }
}
