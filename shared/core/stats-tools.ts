import type { StatsCall } from './stats-contract';
import { isNumber } from './stats-usage';
export const CALL_LIMIT = 12;
export function isCodeMode(name: string | null): boolean {
  return name !== null && /^run_?code$/i.test(name)
}

export function toolSpanUnion(calls: readonly StatsCall[]): number | null {
  const intervals = calls
    .filter((call): call is StatsCall & { startedAt: number; endedAt: number } =>
      isNumber(call.startedAt) && isNumber(call.endedAt))
    .map(call => [call.startedAt, call.endedAt] as const)
    .sort((left, right) => left[0] - right[0])
  if (intervals.length === 0) return null
  let total = 0
  let [start, end] = intervals[0] as readonly [number, number]
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart > end) {
      total += end - start
      start = nextStart
      end = nextEnd
    } else if (nextEnd > end) {
      end = nextEnd
    }
  }
  return total + end - start
}
