import { expect, test } from 'vitest'
import { simpleNight, buildDs1, rec } from '../test/encode'
import { parseDs1 } from '../parse/ds1'
import { buildNight } from '../parse/metrics'
import {
  clockLabel,
  nightGrid,
  placeSessions,
  scoredSpanSec,
} from './nightAxis'

test('clockLabel wraps past midnight', () => {
  expect(clockLabel(0)).toBe('12:00')
  expect(clockLabel(9.5 * 3600)).toBe('21:30')
  expect(clockLabel(13 * 3600)).toBe('01:00')
})

test('placeSessions positions by RTC offset from noon', () => {
  const night = buildNight(
    '13082026',
    parseDs1(simpleNight({ sampleCount: 100 }), '13082026.ds1').sessions,
    false
  )
  const placed = placeSessions(night)
  expect(placed[0]!.offsetSec).toBe(9.5 * 3600) // 21:30
})

test('placeSessions clamps a backwards clock to stay monotonic', () => {
  const records = [
    rec.onDate(26, 8, 13),
    rec.onTime(21, 0, 0),
    ...Array.from({ length: 100 }, () => rec.sample(64, 160)),
    rec.offDate(26, 8, 13),
    rec.offTime(21, 0, 10),
    rec.onDate(26, 8, 13),
    rec.onTime(20, 0, 0), // RTC went backwards
    ...Array.from({ length: 50 }, () => rec.sample(64, 160)),
  ]
  const night = buildNight(
    '13082026',
    parseDs1(buildDs1(records), '13082026.ds1').sessions,
    false
  )
  const placed = placeSessions(night)
  // session 2 placed at session 1's end, not before it
  expect(placed[1]!.offsetSec).toBe(placed[0]!.offsetSec + 10)
})

test('nightGrid fills only occupied buckets', () => {
  const night = buildNight(
    '13082026',
    parseDs1(simpleNight({ sampleCount: 3000 }), '13082026.ds1').sessions,
    false
  )
  const g = nightGrid(night, 288, 'press') // 5-minute buckets
  expect(g.xs).toHaveLength(288)
  const occupied = Array.from(g.min).filter((v) => !Number.isNaN(v))
  expect(occupied.length).toBeGreaterThan(0)
  expect(occupied.length).toBeLessThan(10) // 300 s of data ≪ 24 h
  for (const v of occupied) expect(v).toBe(64)
})

// scoredSpanSec: display-only left-snap of event brackets onto the visible
// pause. Fixture flow: square breathing (100±40, period 40), a 20 s flat
// pause at samples 2000-2199, 10 s of small wiggles (100±8, period 20) at
// 2200-2299, then breathing again. Session starts 22:00 -> offset 36000 s.
function snapNight() {
  const flow = (i: number): number => {
    if (i >= 2000 && i < 2200) return 100 // the true pause
    if (i >= 2200 && i < 2300) return i % 20 < 10 ? 108 : 92 // wiggles
    return i % 40 < 20 ? 140 : 60 // breathing
  }
  const records: number[][] = [rec.onDate(26, 8, 13), rec.onTime(22, 0, 0)]
  for (let i = 0; i < 6000; i++) records.push(rec.sample(55, flow(i)))
  records.push(rec.offDate(26, 8, 13), rec.offTime(22, 10, 0))
  return buildNight(
    '13082026',
    parseDs1(buildDs1(records), '13082026.ds1').sessions,
    false
  )
}

test('scoredSpanSec snaps a late bracket left onto the flat pause', () => {
  const night = snapNight()
  // stored interval sits over the wiggles (the vendor blip-breath quirk)
  const { from, to } = scoredSpanSec(night, {
    kind: 'OSA',
    start: 2200,
    len: 100,
  })
  expect(to - from).toBeCloseTo(10, 9) // duration preserved
  expect(from).toBeGreaterThanOrEqual(36000 + 200) // inside the flat pause
  expect(from).toBeLessThanOrEqual(36000 + 210) // not before it
})

test('scoredSpanSec leaves a correctly-placed bracket alone', () => {
  const night = snapNight()
  const { from } = scoredSpanSec(night, { kind: 'OSA', start: 2100, len: 100 })
  expect(from).toBeCloseTo(36000 + 210, 9)
})

test('scoredSpanSec clamps at the session edges without moving or throwing', () => {
  const night = snapNight()
  const early = scoredSpanSec(night, { kind: 'CSA', start: 30, len: 100 })
  expect(early.from).toBeCloseTo(36000 + 3, 9)
  const late = scoredSpanSec(night, { kind: 'HYP', start: 5950, len: 100 })
  expect(late.from).toBeCloseTo(36000 + 595, 9)
})
