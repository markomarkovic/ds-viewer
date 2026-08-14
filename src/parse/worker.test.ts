import { expect, test } from 'vitest'
import { buildDs1, rec, simpleNight } from '../test/encode'
import { handle } from './worker'

test('handle parses a file into a night and lists its buffers as transfers', () => {
  const buf = simpleNight({ sampleCount: 100 })
  const { res, transfers } = handle({ id: 7, name: '13082026.ds1', buf })
  expect(res.id).toBe(7)
  if (!res.ok) throw new Error(res.error)
  expect(res.night.name).toBe('13082026')
  expect(res.night.samples).toBe(100)
  // press + flow + leak per session = 3 transferables
  expect(transfers).toHaveLength(3)
  expect(transfers[0]).toBeInstanceOf(ArrayBuffer)
})

test('handle reports failure instead of throwing', () => {
  const { res, transfers } = handle({
    id: 1,
    name: 'mystery.ds1',
    buf: new Uint8Array([0x90, 0, 0, 0]).buffer, // orphan sample, undateable name
  })
  expect(res.ok).toBe(false)
  if (res.ok) throw new Error('expected failure')
  expect(res.error).toMatch(/cannot date/)
  expect(transfers).toHaveLength(0)
})

test('short night: breath fields null, transfer list unchanged', () => {
  const { res, transfers } = handle({
    id: 2,
    name: '13082026.ds1',
    buf: simpleNight({ sampleCount: 100 }),
  })
  if (!res.ok) throw new Error(res.error)
  expect(res.night.breath).toBeNull()
  expect(res.night.breaths).toBeNull()
  expect(res.night.scored).toBeNull()
  expect(res.night.ahiScored).toBeNull()
  expect(transfers).toHaveLength(3)
})

test('long breathing night transfers the six BreathTable buffers too', () => {
  const records: number[][] = [rec.onDate(26, 8, 11), rec.onTime(22, 0, 0)]
  for (let i = 0; i < 12000; i++)
    records.push(rec.sample(55, i % 40 < 20 ? 140 : 60))
  records.push(rec.offDate(26, 8, 11), rec.offTime(22, 20, 0))
  const { res, transfers } = handle({
    id: 3,
    name: '11082026.ds1',
    buf: buildDs1(records),
  })
  if (!res.ok) throw new Error(res.error)
  expect(res.night.breaths).not.toBeNull()
  expect(transfers).toHaveLength(9) // press+flow+leak + 6 table arrays
})
