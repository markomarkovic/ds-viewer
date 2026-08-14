import { expect, test } from 'vitest'
import type { BreathTable } from '../types'
import { scoreEvents } from './events'

type Row = {
  insp: number
  exp: number
  next: number
  tv: number
  leak?: number
}
function mkTable(rows: Row[]): BreathTable {
  return {
    count: rows.length,
    insp: Int32Array.from(rows, (r) => r.insp),
    exp: Int32Array.from(rows, (r) => r.exp),
    nextInsp: Int32Array.from(rows, (r) => r.next),
    tv: Int32Array.from(rows, (r) => r.tv),
    bpm: new Float32Array(rows.length),
    leak: Float32Array.from(rows, (r) => r.leak ?? 100),
  }
}

// NEUTRAL: seven breaths, no scorable pause anywhere (index 2's pause is 95,
// which fails the strict > 95 gate). Only i in [2, 3] is inside the scoring
// window for count 7. The CSA TV pattern is pre-wired around index 2
// (tv[1]=200 > tv[2]=150, tv[3]=180 < tv[4]=220) so pause variants flip it on.
const NEUTRAL: Row[] = [
  { insp: 0, exp: 20, next: 40, tv: 200 },
  { insp: 40, exp: 60, next: 80, tv: 200 },
  { insp: 80, exp: 100, next: 195, tv: 150 },
  { insp: 300, exp: 320, next: 340, tv: 180 },
  { insp: 340, exp: 360, next: 380, tv: 220 },
  { insp: 380, exp: 400, next: 420, tv: 200 },
  { insp: 420, exp: 440, next: 0, tv: 0 },
]
const withPause = (pause: number, over: Partial<Row> = {}): BreathTable =>
  mkTable(
    NEUTRAL.map((r, i) =>
      i === 2 ? { ...r, next: r.exp + pause, ...over } : r
    )
  )

test('a 100-sample pause with the TV pattern scores CSA over [exp, next insp)', () => {
  const ev = scoreEvents(withPause(100))
  expect(ev).toEqual([{ kind: 'CSA', start: 100, len: 200 }]) // insp[3]=300 - 100
})

test('pause gate boundaries: 95 no, 96 yes, 494 yes, 495 no', () => {
  expect(scoreEvents(withPause(95))).toHaveLength(0)
  expect(scoreEvents(withPause(96))).toHaveLength(1)
  expect(scoreEvents(withPause(494))).toHaveLength(1)
  expect(scoreEvents(withPause(495))).toHaveLength(0)
})

test('the CSA cap: pause 149 is CSA, 150 is OSA (same TV pattern)', () => {
  expect(scoreEvents(withPause(149))[0]!.kind).toBe('CSA')
  expect(scoreEvents(withPause(150))[0]!.kind).toBe('OSA')
})

test('a broken TV pattern makes it OSA', () => {
  // tv[1] no longer greater than tv[2]
  expect(scoreEvents(withPause(100, { tv: 200 }))[0]!.kind).toBe('OSA')
})

test('the leak gate: 699 counts scores, 700 does not', () => {
  expect(scoreEvents(withPause(100, { leak: 699 }))).toHaveLength(1)
  expect(scoreEvents(withPause(100, { leak: 700 }))).toHaveLength(0)
})

test('the first two and last three breaths never score', () => {
  // the same qualifying pause placed at index 1 (below the window) and at
  // index 4 (count-3, above it) scores nothing
  const at1 = mkTable(
    NEUTRAL.map((r, i) => (i === 1 ? { ...r, next: r.exp + 100 } : r))
  )
  const at4 = mkTable(
    NEUTRAL.map((r, i) => (i === 4 ? { ...r, next: r.exp + 100 } : r))
  )
  expect(scoreEvents(at1)).toHaveLength(0)
  expect(scoreEvents(at4)).toHaveLength(0)
})

test('the uint16 length wrap is faithful to the vendor cast', () => {
  // valid pause via the compensated next (exp+100), but the next surviving
  // inspiration sits 65 636 samples away: len wraps to 100
  const rows = NEUTRAL.map((r, i) =>
    i === 2 ? { ...r, next: r.exp + 100 } : r
  )
  for (let i = 3; i < rows.length; i++) {
    const r = rows[i]!
    rows[i] = {
      ...r,
      insp: r.insp + 65436,
      exp: r.exp + 65436,
      next: r.next && r.next + 65436,
    }
  }
  const ev = scoreEvents(mkTable(rows))
  expect(ev).toHaveLength(1)
  expect(ev[0]!.len).toBe((65736 - 100) & 0xffff) // insp[3]=300+65436 → 100
})

test('neutral, empty and too-small tables yield no events and nothing throws', () => {
  expect(scoreEvents(mkTable(NEUTRAL))).toHaveLength(0) // incl. next=0 last breath
  expect(scoreEvents(mkTable([]))).toHaveLength(0)
  expect(scoreEvents(mkTable(NEUTRAL.slice(0, 5)))).toHaveLength(0)
})
