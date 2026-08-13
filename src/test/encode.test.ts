import { expect, test } from 'vitest'
import { buildDs1, rec, simpleNight } from './encode'

test('P_A sample encodes per DecodePA bit layout', () => {
  expect(rec.sample(100, 300)).toEqual([0x90, 25, 0x02, 0x2c])
  // 12-bit maxima round-trip
  expect(rec.sample(0x0fff, 0x0fff)).toEqual([0x97, 0xff, 0x7f, 0x7f])
})

test('param value splits at 7 bits, not 8', () => {
  expect(rec.param(0x06, 200)).toEqual([0x88, 0x06, 0x01, 0x48])
  expect(rec.param(0x14, 16383)).toEqual([0x88, 0x14, 0x7f, 0x7f])
})

test('switch and event records', () => {
  expect(rec.onDate(26, 8, 13)).toEqual([0x80, 26, 8, 13])
  expect(rec.onTime(21, 30, 0)).toEqual([0x81, 21, 30, 0])
  expect(rec.offTime(23, 0, 5)).toEqual([0x83, 23, 0, 5])
  expect(rec.event(2, 10)).toEqual([0x9a, 10, 0, 0])
})

test('buildDs1 pads to a 256-byte boundary', () => {
  const buf = buildDs1([rec.onDate(26, 8, 13), rec.onTime(21, 30, 0)])
  expect(buf.byteLength % 256).toBe(0)
  const unpadded = buildDs1([rec.onDate(26, 8, 13)], { pad: false })
  expect(unpadded.byteLength).toBe(4)
})

test('simpleNight is well-formed', () => {
  const buf = simpleNight({ sampleCount: 100 })
  expect(buf.byteLength % 4).toBe(0)
  const b = new Uint8Array(buf)
  expect(b[0]).toBe(0x80)
})
