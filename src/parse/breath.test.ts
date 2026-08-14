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

import type { BreathTable } from '../types'
import { MINUTE_DATA, reduceBreaths } from './breath'

type Row = {
  insp: number
  exp: number
  next: number
  tv: number
  bpm: number
  leak: number
}
function mkTable(rows: Row[]): BreathTable {
  return {
    count: rows.length,
    insp: Int32Array.from(rows, (r) => r.insp),
    exp: Int32Array.from(rows, (r) => r.exp),
    nextInsp: Int32Array.from(rows, (r) => r.next),
    tv: Int32Array.from(rows, (r) => r.tv),
    bpm: Float32Array.from(rows, (r) => r.bpm),
    leak: Float32Array.from(rows, (r) => r.leak),
  }
}

// r0 is head-trimmed; r3 hits the tail-break: it contributes to every
// per-breath list but adds no pressure samples.
const ROWS: Row[] = [
  { insp: 100, exp: 120, next: 140, tv: 500, bpm: 30, leak: 999 },
  { insp: 3000, exp: 3020, next: 3040, tv: 200, bpm: 15, leak: 120 },
  { insp: 3040, exp: 3060, next: 3080, tv: 210, bpm: 16, leak: 125 },
  { insp: 8000, exp: 8020, next: 9500, tv: 190, bpm: 14, leak: 130 },
]

test('reduceBreaths: trim, pools, break semantics, vendor truncation', () => {
  const press = new Float32Array(12000).fill(55)
  // poison r3's would-be window: if the break were mis-ordered these samples
  // would drag P95 to 200
  press.fill(200, 8000, 9500)
  const m = reduceBreaths(mkTable(ROWS), press)
  expect(m).not.toBeNull()
  if (!m) return
  expect(m.breaths).toBe(3) // r0 trimmed; r1, r2, r3 counted
  // expPress p90/p95 are CalPress histogram bins over the WHOLE pressSmooth
  // (what the vendor reports as Horizontal Pressure): 10500 samples of 55 and
  // 1500 of 200 put the 900-permille threshold in the 200 bin
  expect(m.expPress.p90).toBe(200)
  expect(m.expPress.p95).toBe(200)
  // avg still comes from the expiratory pool (r1+r2 windows, all 55)
  expect(m.expPress.avg).toBe(55)
  expect(m.expPress.min).toBe(55) // max(trunc(55), CalPress min 55)
  expect(m.inspPress.p90).toBe(55)
  expect(m.inspPress.max).toBe(55) // min(trunc(55), CalPress max 200) = 55
  // tv list [200,210,190] sorted [190,200,210]
  expect(m.tv.p50).toBe(200) // proves r3 IS in the per-breath lists
  expect(m.tv.p90).toBe(210)
  expect(m.tv.p95).toBe(210)
  expect(m.tv.avg).toBe(200)
  // bpm x10 list [150,160,140]
  expect(m.bpm.p50).toBe(15)
  expect(m.bpm.p95).toBe(16)
  expect(m.bpm.avg).toBe(15)
  // ie x10: r1=(3040-3020)/(3020-3000)*10=10, r2=10, r3=(9500-8020)/20*10=740
  expect(m.ie.p50).toBe(1)
  expect(m.ie.p95).toBe(74)
  // abnAvg: all three values (10,10,740) are below abnIe (740+10=750), so no
  // outlier is zeroed; plain f32 average (10+10+740)/3=253.333 -> trunc 253 -> /10
  expect(m.ie.avg).toBe(25.3)
  // mv = bpm*tv: [3000,3360,2660]
  expect(m.mv.p50).toBe(3000)
  expect(m.mv.avg).toBe(3006) // trunc of mean 3006.67
  // leak counts [120,125,130] -> percentile/trunc, printed as counts/10
  expect(m.leak.p50).toBeCloseTo(12.5, 6)
  expect(m.leak.avg).toBeCloseTo(12.5, 6)
})

test('reduceBreaths: null when the expiratory pool is empty (press < 40)', () => {
  const press = new Float32Array(12000).fill(30)
  expect(reduceBreaths(mkTable(ROWS), press)).toBeNull()
})

test('reduceBreaths: null when every breath is head-trimmed', () => {
  const press = new Float32Array(12000).fill(55)
  const rows = ROWS.map((r) => ({ ...r, insp: r.insp % MINUTE_DATA }))
  expect(reduceBreaths(mkTable(rows), press)).toBeNull()
})
