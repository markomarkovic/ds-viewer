import { expect, test } from 'vitest'
import { segmentBreaths } from './breath'

const flat = (len: number, v: number): number[] => Array<number>(len).fill(v)

/** 40-sample exhale lead-in, then insp/exp blocks, then a 40-sample tail. */
function square(blocks: Array<{ amp: number; insp: number; exp: number }>): {
  flowSmooth: Float32Array
  flowBase: Float32Array
} {
  const xs = flat(40, -40)
  for (const b of blocks) xs.push(...flat(b.insp, b.amp), ...flat(b.exp, -40))
  xs.push(...flat(40, -40))
  return {
    flowSmooth: Float32Array.from(xs),
    flowBase: new Float32Array(xs.length),
  }
}

const NORMAL = { amp: 40, insp: 20, exp: 20 }

test('square wave: breath boundaries, TV, BPM, unfinalized last breath', () => {
  const { flowSmooth, flowBase } = square(Array<typeof NORMAL>(9).fill(NORMAL))
  const t = segmentBreaths(flowSmooth, flowBase)
  expect(t.count).toBe(9)
  expect(Array.from(t.insp)).toEqual([
    39, 79, 119, 159, 199, 239, 279, 319, 359,
  ])
  expect(t.exp[0]).toBe(59)
  expect(t.nextInsp[0]).toBe(79)
  expect(Array.from(t.tv)).toEqual(Array<number>(9).fill(158))
  for (let i = 0; i < 8; i++) expect(t.bpm[i]).toBe(15) // 600/40
  expect(t.leak[0]).toBe(-40) // smoothed flow at the sample before onset
  // final breath: closed but never finalized
  expect(t.exp[8]).toBe(379)
  expect(t.nextInsp[8]).toBe(0)
  expect(t.bpm[8]).toBe(0)
})

test('small-breath merge removes iTV<=20 breaths and leaves BPM stale', () => {
  // breath index 2 is tiny: amp 4 (threshold is 3), 10 samples.
  // tvAcc = 43 + 43 + 9*1 = 95 -> iTV = roundHalfEven(19) = 19 <= 20.
  const { flowSmooth, flowBase } = square([
    NORMAL,
    NORMAL,
    { amp: 4, insp: 10, exp: 20 },
    NORMAL,
    NORMAL,
    NORMAL,
  ])
  const t = segmentBreaths(flowSmooth, flowBase)
  expect(t.count).toBe(5)
  expect(Array.from(t.insp)).toEqual([39, 79, 149, 189, 229])
  // predecessor inherits the removed breath's successor...
  expect(t.nextInsp[1]).toBe(149)
  // ...but its BPM is NOT recomputed (vendor bug, reproduced):
  // still 600/(119-79) = 15, not 600/70.
  expect(t.bpm[1]).toBe(15)
})

test('first two breaths are never merged away', () => {
  const { flowSmooth, flowBase } = square([
    { amp: 4, insp: 10, exp: 20 },
    { amp: 4, insp: 10, exp: 20 },
    NORMAL,
    NORMAL,
  ])
  const t = segmentBreaths(flowSmooth, flowBase)
  expect(t.count).toBe(4) // both tiny breaths survive at indices 0 and 1
  expect(t.tv[0]).toBeLessThanOrEqual(20)
  expect(t.tv[1]).toBeLessThanOrEqual(20)
})

test('zero-run compensation shortens the gap-spanning breath interval', () => {
  // B0, then 30 samples of exactly-zero smoothed flow, then B1.
  const xs = [
    ...flat(40, -40),
    ...flat(20, 40),
    ...flat(20, -40),
    ...flat(30, 0),
    ...flat(20, 40),
    ...flat(20, -40),
    ...flat(40, -40),
  ]
  const t = segmentBreaths(Float32Array.from(xs), new Float32Array(xs.length))
  expect(t.count).toBe(2)
  // B1 onset fires at n=109 (prev=0 below thr 3, next=40); zeroRun=30
  expect(t.insp[1]).toBe(109)
  expect(t.nextInsp[0]).toBe(109 - 30) // 79
  expect(t.bpm[0]).toBe(15) // 600/(79-39)
})

test('empty and too-short inputs yield an empty table', () => {
  expect(segmentBreaths(new Float32Array(0), new Float32Array(0)).count).toBe(0)
  expect(segmentBreaths(new Float32Array(12), new Float32Array(12)).count).toBe(
    0
  )
})
