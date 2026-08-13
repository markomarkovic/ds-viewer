import { expect, test } from 'vitest'
import { deci } from '../types'
import { simpleNight } from '../test/encode'
import { parseDs1 } from './ds1'
import {
  accumulateHistogram,
  buildNight,
  lowpass,
  median,
  percentileDeci,
} from './metrics'

const X = [100, 200, 150, 300, 250, 180, 220, 90, 160, 210]

test('lowpass matches ds1.py bit-for-bit', () => {
  const g50 = [
    133.92776489257812, 167.85552978515625, 185.7110595703125, 221.422119140625,
    217.84423828125, 198.1884765625, 187.626953125, 160.87890625, 169.5703125,
    183.046875,
  ]
  const g20 = [
    144.05252620141204, 155.06565775176506, 163.8320721897063,
    173.29009023713286, 176.41261279641606, 175.85576599552004,
    175.09170749440005, 172.08223436800003, 173.17687296000003,
    174.93035520000004,
  ]
  const g3 = [
    119.89000576820388, 120.50516058577719, 121.04655730492493,
    121.56109000507725, 121.91006082997656, 122.14018531956346,
    122.31662544501387, 122.40243151159883, 122.5183016898956,
    122.59939503470875,
  ]
  expect(Array.from(lowpass(X, 50))).toEqual(g50)
  expect(Array.from(lowpass(X, 20))).toEqual(g20)
  expect(Array.from(lowpass(X, 3))).toEqual(g3)
})

test('percentileDeci equals the sorted-array order statistic', () => {
  // data: twelve deci values; ds1.py rule: sorted[n*p//100]
  const data = [63, 61, 60, 62, 65, 61, 60, 64, 61, 62, 60, 61]
  const hist = new Uint32Array(301)
  accumulateHistogram(Uint16Array.from(data), hist)
  expect(percentileDeci(hist, data.length, 50)).toBe(deci(61)) // sorted[6]
  expect(percentileDeci(hist, data.length, 90)).toBe(deci(64)) // sorted[10]
  expect(percentileDeci(hist, data.length, 95)).toBe(deci(65)) // sorted[11]
})

test('percentileDeci property: matches naive sort on random data', () => {
  let seed = 42
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let trial = 0; trial < 20; trial++) {
    const n = 50 + Math.floor(rnd() * 500)
    const data = Uint16Array.from({ length: n }, () => Math.floor(rnd() * 250))
    const hist = new Uint32Array(301)
    accumulateHistogram(data, hist)
    const sorted = Array.from(data).sort((a, b) => a - b)
    for (const p of [50, 90, 95]) {
      expect(percentileDeci(hist, n, p)).toBe(sorted[Math.floor((n * p) / 100)])
    }
  }
})

test('histogram clamps values above 30.0 cmH2O into the top bin', () => {
  const hist = new Uint32Array(301)
  accumulateHistogram(Uint16Array.from([299, 300, 301, 4095]), hist)
  expect(hist[299]).toBe(1)
  expect(hist[300]).toBe(3)
})

test('buildNight computes spec metrics on a synthetic night', () => {
  const buf = simpleNight({
    sampleCount: 3000,
    pressDeci: 64,
    apneaAt: [100, 200],
  })
  const { sessions, partial } = parseDs1(buf, '13082026.ds1')
  const night = buildNight('13082026', sessions, partial)
  expect(night.date).toEqual(new Date(2026, 7, 13, 12, 0, 0))
  expect(night.samples).toBe(3000)
  expect(night.hours).toBeCloseTo(3000 / 10 / 3600, 10)
  expect(night.press.avg).toBe(64) // constant signal
  expect(night.press.median).toBe(64)
  expect(night.press.max).toBeCloseTo(64, 6) // EMA of a constant
  expect(night.events.apnea).toBe(2)
  expect(night.ahi).toBeCloseTo(2 / (3000 / 10 / 3600), 6)
  // constant flow 160 counts -> baseline 160 -> 19.2 L/min
  expect(night.leakMedian).toBeCloseTo(19.2, 3)
  // 1 Hz leak stored per session
  expect(night.sessions[0]!.leak).toHaveLength(300)
})

test('median takes sorted[floor(n/2)]', () => {
  expect(median(Float64Array.from([1, 2, 3, 4]))).toBe(3)
  expect(median(Float64Array.from([1, 2, 3]))).toBe(2)
})
