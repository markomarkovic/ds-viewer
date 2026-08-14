import { expect, test } from 'vitest'
import {
  lowpass,
  lowpassF32,
  lowpassRoundF32,
  median,
  percentileVendor,
  roundHalfEven,
} from './signal'

const X = [100, 200, 150, 300, 250, 180, 220, 90, 160, 210]

test('lowpass and median still work after the move', () => {
  expect(lowpass(X, 50)[0]).toBeCloseTo(133.92776489257812, 9)
  expect(median(Float64Array.from([1, 2, 3]))).toBe(2)
  expect(median(new Float64Array(0))).toBe(0)
})

test('lowpassF32 tracks lowpass within f32 precision', () => {
  const f64 = lowpass(X, 50)
  const f32 = lowpassF32(X, 50)
  for (let i = 0; i < X.length; i++)
    expect(Math.abs(f32[i]! - f64[i]!)).toBeLessThan(1e-3)
  expect(lowpassF32([], 50)).toHaveLength(0)
})

test('lowpassRoundF32 rounds every store half-to-even, unlike lowpassF32', () => {
  const r = lowpassRoundF32(X, 50)
  const f = lowpassF32(X, 50)
  for (const v of r) expect(Number.isInteger(v)).toBe(true)
  let differs = false
  for (let i = 0; i < X.length; i++) if (r[i] !== f[i]) differs = true
  expect(differs).toBe(true)
  // Hand trace of y[0] (a=50, k=a/100=0.5), forward pass (prev seeded with x[0]):
  //   i=0: prev=100, (100*50+100*50)/100=100          -> y0f=100, prev=100
  //   i=1: x=200,    (100*50+200*50)/100=150           -> y1f=150, prev=150
  //   i=2: x=150,    (150*50+150*50)/100=150           -> y2f=150, prev=150
  //   i=3: x=300,    (150*50+300*50)/100=225           -> y3f=225, prev=225
  // Backward pass seeded with y[9]=183 (from the full forward pass), unwinding
  // to index 1 gives prev=168 (168*50+100*50)/100 = 134 at the last (i=0)
  // store, and roundHalfEven(134)=134 (no .5 tie, integer already).
  expect(r[0]).toBe(134)
  expect(r[4]).toBe(218)
  expect(lowpassRoundF32([], 50)).toHaveLength(0)
})

test('roundHalfEven matches .NET Math.Round', () => {
  expect(roundHalfEven(2.5)).toBe(2)
  expect(roundHalfEven(3.5)).toBe(4)
  expect(roundHalfEven(0.5)).toBe(0)
  expect(roundHalfEven(-1.5)).toBe(-2)
  expect(roundHalfEven(156.6)).toBe(157)
  expect(roundHalfEven(10.6)).toBe(11)
  expect(roundHalfEven(19)).toBe(19)
})

test('percentileVendor is the truncated floor(n*p/100) order statistic', () => {
  const s = Float32Array.from([140, 150, 160])
  expect(percentileVendor(s, 50)).toBe(150) // index floor(150/100)=1
  expect(percentileVendor(s, 90)).toBe(160) // index floor(270/100)=2
  expect(percentileVendor(s, 95)).toBe(160)
  expect(percentileVendor(Float32Array.from([10.9, 20.9, 30.9]), 50)).toBe(20)
  expect(percentileVendor(Float32Array.from([7]), 95)).toBe(7)
})
