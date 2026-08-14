import { expect, test } from 'vitest'
import type { BreathTable } from '../types'
import { ahiScored, scoreEvents } from './events'

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

// Hypopnea fixture: breaths 2-4 reduced to TV 100 from a 200 plateau,
// recovery at breath 5. pct(200,100) = 50 everywhere; len = exp[4] - insp[2].
const hypRows = (exp4: number): Row[] => [
  { insp: 0, exp: 20, next: 40, tv: 200 },
  { insp: 40, exp: 60, next: 80, tv: 200 },
  { insp: 80, exp: 100, next: 120, tv: 100 },
  { insp: 120, exp: 140, next: 160, tv: 100 },
  { insp: 160, exp: exp4, next: 200, tv: 100 },
  { insp: 200, exp: 220, next: 240, tv: 200 },
  { insp: 240, exp: 260, next: 280, tv: 200 },
  { insp: 280, exp: 300, next: 0, tv: 0 },
]

test('a 100-sample TV reduction scores HYP from first reduced insp to last reduced exp', () => {
  const ev = scoreEvents(mkTable(hypRows(180)))
  expect(ev).toEqual([{ kind: 'HYP', start: 80, len: 100 }]) // 180 - 80
})

test('duration gate: len 99 does not score, len 100 does', () => {
  expect(scoreEvents(mkTable(hypRows(179)))).toHaveLength(0)
  expect(scoreEvents(mkTable(hypRows(180)))).toHaveLength(1)
})

test('entry band is open: an exact 30% reduction does not enter', () => {
  // pct(200, 140) = 30 exactly
  const rows = hypRows(180).map((r, i) =>
    i >= 2 && i <= 4 ? { ...r, tv: 140 } : r
  )
  expect(scoreEvents(mkTable(rows))).toHaveLength(0)
})

test('persistence band is closed: a breath at exactly 30% continues the event', () => {
  // entry breaths at TV 100 (50%), continuation breath 3 at TV 140 (30% vs tv[1]=200)
  const rows = hypRows(180).map((r, i) => (i === 3 ? { ...r, tv: 140 } : r))
  // r4 = pct(200, 140) = 30 -> not (<30 || >70) -> keep scanning; still scores
  expect(scoreEvents(mkTable(rows))).toHaveLength(1)
})

test('a recovery overshoot (r3 > 70) aborts the scan without scoring', () => {
  // breaths 2-4 reduced to TV 100 (50% entry); breath 5 jumps to TV 400 so at
  // j=4 r3 = pct(400, 100) = 75 — above the open recovery band. The vendor
  // breaks the scan there (IL_01ea). Without the abort, j=5 would see
  // r3 = pct(1000, 400) = 60 and score a hypopnea off the later recovery.
  const rows: Row[] = [
    { insp: 0, exp: 20, next: 40, tv: 200 },
    { insp: 40, exp: 60, next: 80, tv: 200 },
    { insp: 80, exp: 100, next: 120, tv: 100 },
    { insp: 120, exp: 140, next: 160, tv: 100 },
    { insp: 160, exp: 180, next: 200, tv: 100 },
    { insp: 200, exp: 220, next: 240, tv: 400 },
    { insp: 240, exp: 260, next: 280, tv: 1000 },
    { insp: 280, exp: 300, next: 320, tv: 1000 },
    { insp: 320, exp: 340, next: 0, tv: 0 },
  ]
  expect(scoreEvents(mkTable(rows))).toHaveLength(0)
  // control: TV 300 keeps r3 = pct(300, 100) = 66.7 inside (30,70) — that IS
  // the recovery, closing the event at exp[4]
  const ctrl = rows.map((r, i) => (i === 5 ? { ...r, tv: 300 } : r))
  expect(scoreEvents(mkTable(ctrl))).toEqual([
    { kind: 'HYP', start: 80, len: 100 },
  ])
})

test('apneas precede hypopneas in the output regardless of time order', () => {
  // hypopnea early (breaths 2-4), apnea later: give breath 5 a 100-sample pause
  const rows = hypRows(180).map((r, i) =>
    i === 5 ? { ...r, next: r.exp + 100 } : r
  )
  // widen the table so index 5 is within [2, count-4]
  rows.push({ insp: 340, exp: 360, next: 380, tv: 200 })
  rows.push({ insp: 380, exp: 400, next: 420, tv: 200 })
  rows.push({ insp: 420, exp: 440, next: 0, tv: 0 })
  const ev = scoreEvents(mkTable(rows))
  expect(ev.map((e) => e.kind)).toEqual(['OSA', 'HYP'])
  expect(ev[0]!.start).toBeGreaterThan(ev[1]!.start) // file order, not time order
})

test('the 26 s continuation stop abandons a reduction that would otherwise score', () => {
  // 13 reduced breaths at 26-sample spacing (insp 80 + 26k), then a recovery
  // breath at index 15 that WOULD close a scorable event (len >> 100) — but
  // the scan reaches insp[12] - start = 260 samples first: trunc(26.0) > 25
  // breaks before the recovery is ever seen. No event.
  const rows: Row[] = [
    { insp: 0, exp: 20, next: 40, tv: 200 },
    { insp: 40, exp: 60, next: 80, tv: 200 },
  ]
  for (let k = 0; k <= 12; k++)
    rows.push({
      insp: 80 + 26 * k,
      exp: 96 + 26 * k,
      next: 106 + 26 * k,
      tv: 100,
    })
  rows.push({ insp: 420, exp: 440, next: 460, tv: 200 }) // recovery (idx 15)
  rows.push({ insp: 460, exp: 480, next: 500, tv: 200 })
  rows.push({ insp: 500, exp: 520, next: 540, tv: 200 })
  rows.push({ insp: 540, exp: 560, next: 0, tv: 0 })
  expect(scoreEvents(mkTable(rows))).toHaveLength(0)
  // control: shorten the reduction to 9 breaths (max insp offset 208 < 260)
  // and the same recovery scores
  const short: Row[] = [
    rows[0]!,
    rows[1]!,
    ...rows.slice(2, 11), // 9 reduced breaths, insp 80..288
    { insp: 340, exp: 360, next: 380, tv: 200 }, // recovery
    { insp: 380, exp: 400, next: 420, tv: 200 },
    { insp: 420, exp: 440, next: 460, tv: 200 },
    { insp: 460, exp: 480, next: 0, tv: 0 },
  ]
  const ev = scoreEvents(mkTable(short))
  expect(ev).toHaveLength(1)
  expect(ev[0]!.kind).toBe('HYP')
})

const evs = (...kinds: Array<'OSA' | 'CSA' | 'HYP'>) =>
  kinds.map((kind) => ({ kind, start: 0, len: 100 }))

test('ahiScored: apneas per non-zero-pressure hour, truncated to one decimal', () => {
  // 20000 samples, 3000 of them zero -> valid 17000 > 12000 -> minus 3000 -> 14000
  const press = new Float32Array(20000).fill(55)
  press.fill(0, 0, 3000)
  // 2 apneas: trunc(2 * 360000 / 14000) / 10 = trunc(51.43)/10 = 5.1
  expect(ahiScored(evs('OSA', 'CSA'), press)).toBe(5.1)
})

test('ahiScored: hypopneas are not counted', () => {
  const press = new Float32Array(20000).fill(55)
  press.fill(0, 0, 3000)
  expect(ahiScored(evs('OSA', 'CSA', 'HYP', 'HYP'), press)).toBe(5.1)
})

test('ahiScored: no 5-minute subtraction at or under 20 valid minutes', () => {
  const press = new Float32Array(10000).fill(55) // valid 10000, not > 12000
  // trunc(2 * 360000 / 10000)/10 = 7.2
  expect(ahiScored(evs('OSA', 'OSA'), press)).toBe(7.2)
})

test('ahiScored: zero apneas is 0.0', () => {
  expect(ahiScored(evs('HYP'), new Float32Array(10000).fill(55))).toBe(0)
})
