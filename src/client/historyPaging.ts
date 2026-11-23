import type { HistoryPage, HistoryPart, HistoryRow } from '../shared/types'
import type { HistoryCursor, HistoryFetcher } from './timelineWire'

export const HISTORY_PAGE_MAX = 1_000

const HISTORY_PAGES_MAX = 10_000

export const CANCELLED = 'cancelled'

export type HistoryRows<T> = T[] | typeof CANCELLED | null

export type HistoryTailRows<T> = T[] | 'reload' | typeof CANCELLED | null

export interface HistoryPagingOptions {
  rev: number
  cancelled: () => boolean
}

export function nextHistoryCursor(page: HistoryPage): HistoryCursor | undefined {
  if (page.beforeSeq !== undefined) return { beforeSeq: page.beforeSeq }
  if (page.beforeIndex !== undefined) return { beforeIndex: page.beforeIndex }
  return undefined
}

export async function readHistoryPage(
  history: HistoryFetcher,
  part: HistoryPart,
  cursor: HistoryCursor | undefined,
  limit: number,
  options: HistoryPagingOptions,
): Promise<HistoryPage | typeof CANCELLED | null> {
  if (options.cancelled()) return CANCELLED
  const page = await history(part, cursor, limit)
  if (options.cancelled()) return CANCELLED
  return page === null || page.rev !== options.rev ? null : page
}

export async function loadAllHistory<T extends HistoryRow>(
  history: HistoryFetcher,
  part: HistoryPart,
  options: HistoryPagingOptions,
): Promise<HistoryRows<T>> {
  let cursor: HistoryCursor | undefined
  const collected: T[][] = []
  for (let pages = 0; ; pages++) {
    /* v8 ignore next 1 */
    if (pages >= HISTORY_PAGES_MAX) return null
    const page = await readHistoryPage(history, part, cursor, HISTORY_PAGE_MAX, options)
    if (page === CANCELLED || page === null) return page
    collected.push(page.rows as T[])
    const next = nextHistoryCursor(page)
    if (next === undefined || page.rows.length === 0) break
    if (next.beforeSeq === cursor?.beforeSeq && next.beforeIndex === cursor?.beforeIndex) return null
    cursor = next
  }
  return pagesOldestFirst(collected)
}

export type HistorySeqRow = { seq: number; ord?: number }

export function historyRowKey(row: HistorySeqRow): string {
  return String(row.seq) + ':' + String(row.ord ?? '')
}

function compareRows(a: HistorySeqRow, b: HistorySeqRow): number {
  const bySeq = a.seq - b.seq
  return bySeq !== 0 ? bySeq : (a.ord ?? 0) - (b.ord ?? 0)
}

function pagesOldestFirst<T>(pages: readonly T[][]): T[] {
  const rows: T[] = []
  for (let index = pages.length - 1; index >= 0; index--) rows.push(...pages[index])
  return rows
}

function overlapStart(rows: readonly HistorySeqRow[], target: HistorySeqRow): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2)
    if (compareRows(rows[mid], target) < 0) low = mid + 1
    else high = mid
  }
  return low
}

export function mergeHistoryRows<T extends HistorySeqRow>(old: T[], add: T[]): T[] {
  if (add.length === 0) return old
  const last = old.at(-1)
  if (last === undefined || compareRows(add[0], last) > 0) return [...old, ...add]
  const start = overlapStart(old, add[0])
  const region = new Map<string, T>()
  for (const row of old.slice(start)) region.set(historyRowKey(row), row)
  for (const row of add) region.set(historyRowKey(row), row)
  return [...old.slice(0, start), ...[...region.values()].sort(compareRows)]
}

export async function loadTailHistory<T extends HistorySeqRow>(
  history: HistoryFetcher,
  part: HistoryPart,
  old: T[],
  options: HistoryPagingOptions,
): Promise<HistoryRows<T>> {
  const reloadAll = (): Promise<HistoryRows<T>> => loadAllHistory(history, part, options) as Promise<HistoryRows<T>>
  const collected: T[][] = []
  let unseen = 0
  let cursor: number | undefined
  let reachedStart = false
  let total = 0
  let first = 0
  for (let pages = 0; ; pages++) {
    /* v8 ignore next 1 */
    if (pages >= HISTORY_PAGES_MAX) return null
    const page = await readHistoryPage(
      history,
      part,
      cursor === undefined ? undefined : { beforeSeq: cursor },
      HISTORY_PAGE_MAX,
      options,
    )
    if (page === CANCELLED || page === null) return page
    const rows = page.rows as unknown as T[]
    collected.push(rows)
    total = page.total
    first = page.first
    if (page.atStart) reachedStart = true
    if (!reachedStart && total < old.length) return reloadAll()
    unseen += Math.max(0, page.first + rows.length - Math.max(page.first, old.length))
    if (unseen >= Math.max(0, page.total - old.length)
      || page.atStart || page.beforeSeq === undefined || rows.length === 0) break
    if (page.beforeSeq === cursor) return null
    cursor = page.beforeSeq
  }
  const tail = pagesOldestFirst(collected)
  if (reachedStart) return tail
  if (total < old.length || first > old.length || tail.length === 0) {
    return reloadAll()
  }
  if (first === 0) return tail.length === total ? tail : reloadAll()
  if (first < old.length && historyRowKey(old[first]) !== historyRowKey(tail[0])) {
    return reloadAll()
  }
  if (compareRows(old[first - 1], tail[0]) >= 0) return reloadAll()
  const merged = [...old.slice(0, first), ...tail]
  return merged.length === total ? merged : reloadAll()
}

export async function loadHistoryTailIndex<T extends HistoryRow>(
  history: HistoryFetcher,
  part: HistoryPart,
  old: T[],
  options: HistoryPagingOptions,
  limit: number = HISTORY_PAGE_MAX,
): Promise<HistoryTailRows<T>> {
  let page = await readHistoryPage(history, part, undefined, limit, options)
  if (page === CANCELLED || page === null) return page
  if (page.atStart) return page.rows as T[]
  if (page.total < old.length) return 'reload'
  if (page.total === old.length) return old
  const collected: T[][] = [page.rows as T[]]
  let first = page.first
  let cursor = nextHistoryCursor(page)
  let pages = 1
  while (first > old.length && cursor !== undefined) {
    /* v8 ignore next 1 */
    if (++pages > HISTORY_PAGES_MAX) return 'reload'
    page = await readHistoryPage(history, part, cursor, limit, options)
    if (page === CANCELLED || page === null) return page
    collected.push(page.rows as T[])
    first = page.first
    if (page.atStart) return pagesOldestFirst(collected)
    const next = nextHistoryCursor(page)
    if (next?.beforeIndex === cursor.beforeIndex && next?.beforeSeq === cursor.beforeSeq) return 'reload'
    cursor = next
  }
  if (first > old.length) return 'reload'
  const merged = [...old.slice(0, first), ...pagesOldestFirst(collected)]
  return merged.length === page.total ? merged : 'reload'
}
