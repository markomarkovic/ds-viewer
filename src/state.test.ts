import { expect, test } from 'vitest'
import type { Lpm, Night } from './types'
import { deci } from './types'
import { initialState, kpis, reducer, visibleNights } from './state'

const night = (name: string, y: number, m: number, d: number): Night => ({
  name,
  date: new Date(y, m - 1, d, 12, 0, 0),
  sessions: [],
  hours: 7,
  samples: 252000,
  press: {
    avg: deci(61),
    median: deci(62),
    p90: deci(66),
    p95: deci(69),
    max: deci(75),
  },
  histogram: new Uint32Array(301),
  leakMedian: 19.4 as Lpm,
  events: { apnea: 7, pressUp: 3, pressDown: 4 },
  ahi: 1,
  partial: false,
  breath: null,
  breaths: null,
})

test('night-loaded inserts sorted by date descending', () => {
  let s = initialState
  s = reducer(s, { type: 'night-loaded', night: night('01082026', 2026, 8, 1) })
  s = reducer(s, {
    type: 'night-loaded',
    night: night('13082026', 2026, 8, 13),
  })
  s = reducer(s, { type: 'night-loaded', night: night('05082026', 2026, 8, 5) })
  expect(s.nights.map((n) => n.name)).toEqual([
    '13082026',
    '05082026',
    '01082026',
  ])
})

test('re-dropping the same stem replaces, never duplicates', () => {
  let s = initialState
  s = reducer(s, { type: 'night-loaded', night: night('01082026', 2026, 8, 1) })
  const replacement = { ...night('01082026', 2026, 8, 1), hours: 3 }
  s = reducer(s, { type: 'night-loaded', night: replacement })
  expect(s.nights).toHaveLength(1)
  expect(s.nights[0]!.hours).toBe(3)
})

test('pending counts down on load and on failure', () => {
  let s = reducer(initialState, {
    type: 'ingest-started',
    accepted: 2,
    skippedCount: 0,
    refused: [],
  })
  expect(s.pending).toBe(2)
  s = reducer(s, { type: 'night-loaded', night: night('01082026', 2026, 8, 1) })
  s = reducer(s, { type: 'file-failed', name: 'bad.ds1', error: 'nope' })
  expect(s.pending).toBe(0)
  expect(s.notices.some((n) => n.kind === 'error')).toBe(true)
})

test('refused files produce a notice naming them', () => {
  const s = reducer(initialState, {
    type: 'ingest-started',
    accepted: 0,
    skippedCount: 3,
    refused: ['a.ds3'],
  })
  expect(s.notices.map((n) => n.text).join(' ')).toMatch(/a\.ds3/)
})

test('visibleNights filters by range inclusive', () => {
  let s = initialState
  for (const [name, d] of [
    ['01082026', 1],
    ['05082026', 5],
    ['13082026', 13],
  ] as const) {
    s = reducer(s, { type: 'night-loaded', night: night(name, 2026, 8, d) })
  }
  s = reducer(s, {
    type: 'set-range',
    range: {
      from: new Date(2026, 7, 2).getTime(),
      to: new Date(2026, 7, 13, 23).getTime(),
    },
  })
  expect(visibleNights(s).map((n) => n.name)).toEqual(['13082026', '05082026'])
})

test('kpis averages over the given nights', () => {
  const nights = [night('a', 2026, 8, 1), night('b', 2026, 8, 2)]
  const k = kpis(nights)
  expect(k.count).toBe(2)
  expect(k.totalHours).toBe(14)
  expect(k.avgHours).toBe(7)
  expect(k.avgP95).toBeCloseTo(6.9, 6)
  expect(k.avgAhi).toBe(1)
})

test('kpis of nothing is zeros, not NaN', () => {
  const k = kpis([])
  expect(k.avgP95).toBe(0)
  expect(k.avgAhi).toBe(0)
})

test('kpis averages breath-derived HP percentiles over nights that have them', () => {
  const hp = (p90: number, p95: number): Night['breath'] =>
    ({
      breaths: 1000,
      expPress: { avg: 60, min: 41, p90, p95 },
      inspPress: { avg: 65, max: 85, p90: 70, p95: 72 },
      tv: { avg: 199, p50: 196, p90: 249, p95: 289 },
      bpm: { avg: 15.1, p50: 15, p90: 18.1, p95: 19.3 },
      ie: { avg: 1.2, p50: 1.2, p90: 1.5, p95: 1.7 },
      mv: { avg: 3000, p50: 2950, p90: 4500, p95: 5600 },
      leak: { avg: 14.8, p50: 14.7, p90: 17.4, p95: 18.2 },
    }) as Night['breath']
  const a = { ...night('01082026', 2026, 8, 1), breath: hp(60, 66) }
  const b = { ...night('02082026', 2026, 8, 2), breath: hp(66, 72) }
  const c = night('03082026', 2026, 8, 3) // breath: null
  const k = kpis([a, b, c])
  expect(k.avgHp90).toBeCloseTo(6.3, 9) // mean of 6.0 and 6.6 cmH2O
  expect(k.avgHp95).toBeCloseTo(6.9, 9)
  expect(kpis([c]).avgHp95).toBeNull()
})
