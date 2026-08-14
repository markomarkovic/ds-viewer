import type { BreathMetrics, Deci, Night } from './types'
import { cmH2O } from './types'

export type DateRange = { from: number | null; to: number | null }
export type Notice = { id: number; kind: 'info' | 'error'; text: string }

export type State = {
  nights: Night[]
  range: DateRange
  selected: string | null
  notices: Notice[]
  pending: number
}

export type Action =
  | {
      type: 'ingest-started'
      accepted: number
      skippedCount: number
      refused: string[]
    }
  | { type: 'night-loaded'; night: Night }
  | { type: 'file-failed'; name: string; error: string }
  | { type: 'set-range'; range: DateRange }
  | { type: 'select-night'; name: string | null }
  | { type: 'dismiss-notice'; id: number }

export const initialState: State = {
  nights: [],
  range: { from: null, to: null },
  selected: null,
  notices: [],
  pending: 0,
}

let noticeId = 0
const notice = (kind: Notice['kind'], text: string): Notice => ({
  id: ++noticeId,
  kind,
  text,
})

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'ingest-started': {
      const notices = [...state.notices]
      if (action.refused.length)
        notices.push(
          notice(
            'error',
            `Refused (unsupported sibling format): ${action.refused.join(', ')}`
          )
        )
      if (action.skippedCount)
        notices.push(
          notice('info', `${action.skippedCount} non-.ds1 files skipped`)
        )
      if (action.accepted > 300)
        notices.push(
          notice(
            'info',
            `${action.accepted} files is a lot; parsing may take a while`
          )
        )
      return { ...state, pending: state.pending + action.accepted, notices }
    }
    case 'night-loaded': {
      const nights = state.nights.filter((n) => n.name !== action.night.name)
      nights.push(action.night)
      nights.sort((a, b) => b.date.getTime() - a.date.getTime())
      return { ...state, nights, pending: Math.max(0, state.pending - 1) }
    }
    case 'file-failed':
      return {
        ...state,
        pending: Math.max(0, state.pending - 1),
        notices: [
          ...state.notices,
          notice('error', `${action.name}: ${action.error}`),
        ],
      }
    case 'set-range':
      return { ...state, range: action.range }
    case 'select-night':
      return { ...state, selected: action.name }
    case 'dismiss-notice':
      return {
        ...state,
        notices: state.notices.filter((n) => n.id !== action.id),
      }
  }
}

export function visibleNights(state: State): Night[] {
  const { from, to } = state.range
  return state.nights.filter((n) => {
    const t = n.date.getTime()
    return (from === null || t >= from) && (to === null || t <= to)
  })
}

export function kpis(nights: Night[]): {
  count: number
  totalHours: number
  avgHours: number
  avgP95: number
  avgAhi: number
  avgLeak: number
  avgHp90: number | null
  avgHp95: number | null
} {
  const count = nights.length
  const totalHours = nights.reduce((a, n) => a + n.hours, 0)
  const avg = (f: (n: Night) => number) =>
    count ? nights.reduce((a, n) => a + f(n), 0) / count : 0
  const withBreath = nights.filter((n) => n.breath !== null)
  const avgB = (f: (b: BreathMetrics) => Deci) =>
    withBreath.length
      ? withBreath.reduce((a, n) => a + cmH2O(f(n.breath!)), 0) /
        withBreath.length
      : null
  return {
    count,
    totalHours,
    avgHours: count ? totalHours / count : 0,
    avgP95: avg((n) => cmH2O(n.press.p95)),
    avgAhi: avg((n) => n.ahi),
    avgLeak: avg((n) => n.leakMedian),
    avgHp90: avgB((b) => b.expPress.p90),
    avgHp95: avgB((b) => b.expPress.p95),
  }
}
