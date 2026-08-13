import { expect, test } from 'vitest'
import { simpleNight, buildDs1, rec } from '../test/encode'
import { parseDs1 } from '../parse/ds1'
import { buildNight } from '../parse/metrics'
import { clockLabel, nightGrid, placeSessions } from './nightAxis'

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
