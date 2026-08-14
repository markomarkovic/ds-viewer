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
