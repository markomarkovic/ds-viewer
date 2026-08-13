import { expect, test } from 'vitest'
import { buildDs1, rec, simpleNight } from '../test/encode'
import { paramKey } from '../types'
import { dateFromName, parseDs1 } from './ds1'

test('dateFromName parses leading DDMMYYYY, tolerates suffixes', () => {
  expect(dateFromName('13082026.ds1')).toEqual(new Date(2026, 7, 13, 12, 0, 0))
  expect(dateFromName('01072026 (1).ds1')).toEqual(
    new Date(2026, 6, 1, 12, 0, 0)
  )
  expect(dateFromName('notadate.ds1')).toBeNull()
  expect(dateFromName('99999999.ds1')).toBeNull() // month 99 invalid
})

test('single session: samples, params, events, times', () => {
  const buf = simpleNight({ sampleCount: 100, apneaAt: [50] })
  const { sessions, partial } = parseDs1(buf, '13082026.ds1')
  expect(partial).toBe(false)
  expect(sessions).toHaveLength(1)
  const s = sessions[0]!
  expect(s.start).toEqual(new Date(2026, 7, 13, 21, 30, 0))
  expect(s.press).toHaveLength(100)
  expect(s.press[0]).toBe(64)
  expect(s.flow[0]).toBe(160)
  expect(s.params.get(paramKey(0x04))).toBe(3)
  expect(s.params.get(paramKey(0x06))).toBe(200)
  expect(s.events).toHaveLength(1)
  expect(s.events[0]!.kind).toBe('APNEA')
  expect(s.events[0]!.index).toBe(50)
  expect(s.events[0]!.d1).toBe(10)
})

test('P_A bit extraction round-trips through the encoder', () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [100, 300],
    [512, 129],
    [4095, 4095],
    [1, 4094],
  ]
  const records = [rec.onDate(26, 8, 13), rec.onTime(0, 0, 0)]
  for (const [p, f] of cases) records.push(rec.sample(p, f))
  const { sessions } = parseDs1(buildDs1(records), '13082026.ds1')
  const s = sessions[0]!
  cases.forEach(([p, f], i) => {
    expect(s.press[i]).toBe(p)
    expect(s.flow[i]).toBe(f)
  })
})

test('multi-session file splits correctly', () => {
  const records = [
    rec.onDate(26, 8, 13),
    rec.onTime(12, 0, 0),
    rec.sample(64, 160),
    rec.sample(64, 160),
    rec.offDate(26, 8, 13),
    rec.offTime(12, 0, 1),
    rec.onDate(26, 8, 14),
    rec.onTime(5, 0, 0),
    rec.sample(70, 170),
  ]
  const { sessions } = parseDs1(buildDs1(records), '13082026.ds1')
  expect(sessions).toHaveLength(2)
  expect(sessions[0]!.press).toHaveLength(2)
  expect(sessions[1]!.press).toHaveLength(1)
  expect(sessions[1]!.start).toEqual(new Date(2026, 7, 14, 5, 0, 0))
})

test('missing OFF marker: end derived from sample count', () => {
  const records = [rec.onDate(26, 8, 13), rec.onTime(22, 0, 0)]
  for (let i = 0; i < 25; i++) records.push(rec.sample(64, 160))
  const { sessions } = parseDs1(buildDs1(records), '13082026.ds1')
  // 25 samples = 2.5 s; end rounds via Date ms
  expect(sessions[0]!.end.getTime()).toBe(
    new Date(2026, 7, 13, 22, 0, 0).getTime() + 2500
  )
})

test('zero-fill padding does not create sessions or samples', () => {
  const { sessions } = parseDs1(
    buildDs1([rec.onDate(26, 8, 13), rec.onTime(1, 0, 0)]),
    '13082026.ds1'
  )
  expect(sessions).toHaveLength(0) // zero samples -> dropped
})

test('corrupt records are skipped and mark the file partial', () => {
  const records = [
    rec.onDate(26, 8, 13),
    rec.onTime(1, 0, 0),
    rec.sample(64, 160),
    [0x12, 0x34, 0x56, 0x78], // bit 7 clear: corrupt
    rec.sample(65, 161),
  ]
  const { sessions, partial } = parseDs1(
    buildDs1(records, { pad: false }),
    '13082026.ds1'
  )
  expect(partial).toBe(true)
  expect(sessions[0]!.press).toHaveLength(2)
  expect(sessions[0]!.press[1]).toBe(65)
})

test('orphan samples synthesise a noon session from the filename', () => {
  const records = [rec.sample(64, 160), rec.sample(64, 160)]
  const { sessions } = parseDs1(
    buildDs1(records, { pad: false }),
    '05062026.ds1'
  )
  expect(sessions).toHaveLength(1)
  expect(sessions[0]!.start).toEqual(new Date(2026, 5, 5, 12, 0, 0))
})

test('undateable file with orphan samples throws', () => {
  const records = [rec.sample(64, 160)]
  expect(() =>
    parseDs1(buildDs1(records, { pad: false }), 'mystery.ds1')
  ).toThrow(/cannot date/)
})
