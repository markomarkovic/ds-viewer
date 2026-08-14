# Respiratory Event Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the vendor's respiratory event scorer (OSA/CSA/hypopnea) and its AHI arithmetic, validate per-event against the vendor's own `.EVT5` output across the corpus, and surface the events and AHI in the UI.

**Architecture:** A new pure module `src/parse/events.ts` (`scoreEvents` over the retained `BreathTable`, `ahiScored` over the padded smoothed pressure) wired into `buildNight`; a test-only `.EVT5` reader; an opt-in per-event differential test; UI switches AHI to the scored value and draws event lanes + waveform spans.

**Tech Stack:** TypeScript (Preact/uPlot, Vitest). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-14-event-scoring-design.md` — its "The algorithm" and "EVT5 file layout" sections are normative; implementers follow them and need not re-read the disassembly.

## Global Constraints

- No `any`; branded units where applicable; `import type` for type-only imports; Prettier clean (`make lint`).
- Bundle budget: `make build` fails above 800 KB.
- Real recordings, `.EVT5` files, and values derived from them never enter the repo. Oracle tests opt-in on `DS1_DIR`.
- **Vendor-port numerics:** integer arithmetic uses `Math.trunc` at exactly the spec's points; the uint16 length wrap is `& 0xffff`; percentage ratios are plain float64 (`(a - b) * 1.0 / a * 100` — JS semantics match C# exactly, including NaN/Infinity from zero TVs failing every band test). No `Math.round` anywhere in `src/parse/events.ts`.
- Event ordering is load-bearing: all apneas in breath order, then all hypopneas in breath order. The oracle compares in file order.
- Existing behavior frozen: everything v1 shipped (`press.*`, `breath`, `breaths`, `leakMedian`, device `events`/`ahi`, `make test-diff`, `make test-reports` at 6/7) must not change.
- Oracle tolerance: none — per-event equality (type, start, duration) is exact or the port is wrong. Loosening requires a documented reason in the spec, never a silent slack.
- Git: work on branch `event-scoring` off `develop`; commit at task checkpoints (authorized for this run); never add Co-Authored-By or any AI attribution; do not push unless asked.

## Plan-level rulings

1. **`ScoredKind`/`ScoredEvent` live in `src/types.ts`**, not `events.ts` as the spec's module sketch shows — `Night` references `ScoredEvent`, and `events.ts` imports `BreathTable` from `types.ts`, so placing them in `events.ts` would create an import cycle. Same ruling as v1's `BreathTable`. `events.ts` imports them type-only.
2. **`expected.json` may lack the daily OSA/CSA/AHI fields** (Task 6 of v1 extracted what its assertions needed). Task 5 checks and, if absent, extends `tools/reports-to-json.py` (labels: the daily report prints AHI plus OSA/CSA counts; the statistical table's `AHI`/`Apnea` columns are already extracted per night) and regenerates. SELFCHECK stays unedited.

---

### Task 1: Types + `scoreEvents` apnea path (`CalEvents` port)

**Files:**

- Modify: `src/types.ts` (ScoredKind, ScoredEvent, two Night fields)
- Modify: `src/parse/metrics.ts` (temporary `scored: null, ahiScored: null` in the return object — Task 4 replaces)
- Modify: `src/state.test.ts` (the `night()` literal gains the two fields)
- Create: `src/parse/events.ts`
- Create: `src/parse/events.test.ts`

**Interfaces:**

- Consumes: `BreathTable` from `../types` (fields `count`, `insp`, `exp`, `nextInsp`, `tv`, `bpm`, `leak`).
- Produces (later tasks rely on these exact shapes):

```ts
// src/types.ts
export type ScoredKind = 'OSA' | 'CSA' | 'HYP'

export type ScoredEvent = {
  kind: ScoredKind
  start: number // sample index on the padded night timeline (10 Hz)
  len: number // samples
}
```

`Night` gains, after `breaths`:

```ts
scored: ScoredEvent[] | null // null together with breath
ahiScored: number | null
```

- `scoreEvents(table: BreathTable): ScoredEvent[]` from `./events` — after this task it emits only apneas; Task 2 adds the hypopnea scan inside it.

- [ ] **Step 1: Add the types.** In `src/types.ts` add `ScoredKind`/`ScoredEvent` above `Night` and the two `Night` fields exactly as above. In `buildNight`'s return object add `scored: null, ahiScored: null` after `breaths`. In `src/state.test.ts`'s `night()` literal add `scored: null, ahiScored: null`. Run `pnpm typecheck` — green.

- [ ] **Step 2: Write the failing tests.** Create `src/parse/events.test.ts`:

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail** — `pnpm vitest run src/parse/events.test.ts` → FAIL: cannot resolve `./events`.

- [ ] **Step 4: Implement `src/parse/events.ts`:**

```ts
import type { BreathTable, ScoredEvent } from '../types'

// Port of DP.Analysis.AnalysisFileV2.CalEvents (apnea + OSA/CSA split).
// The spec's "The algorithm" section is normative; constants and comparison
// order are verbatim. iBlockID is not ported (feeds only the vendor's file).
export function scoreEvents(table: BreathTable): ScoredEvent[] {
  const events: ScoredEvent[] = []
  const { count, insp, exp, nextInsp, tv, leak } = table
  for (let i = 2; i < count - 3; i++) {
    const pause = nextInsp[i]! - exp[i]!
    if (pause > 95 && pause < 495 && leak[i]! < 700) {
      const csa = tv[i - 1]! > tv[i]! && tv[i + 1]! < tv[i + 2]! && pause < 150
      const start = exp[i]!
      events.push({
        kind: csa ? 'CSA' : 'OSA',
        start,
        len: (insp[i + 1]! - start) & 0xffff, // vendor conv.u2 wrap
      })
    }
  }
  return events
}
```

- [ ] **Step 5: Run tests to verify they pass** — `pnpm vitest run src/parse/events.test.ts && pnpm typecheck && pnpm lint`. Expected: PASS.

- [ ] **Step 6: Commit** — `feat: apnea scoring port of CalEvents with scored-event types`

---

### Task 2: Hypopnea scan (`CalculationHI` port)

**Files:**

- Modify: `src/parse/events.ts`
- Modify: `src/parse/events.test.ts` (append)

**Interfaces:**

- Consumes/produces: `scoreEvents` now appends hypopneas after all apneas (spec: Event ordering). No signature change.

- [ ] **Step 1: Write the failing tests** (append; reuse `mkTable`):

```ts
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
```

- [ ] **Step 2: Run to verify the new tests fail** (existing apnea tests stay green).

- [ ] **Step 3: Implement.** In `events.ts`, add:

```ts
// pct(a, b) = (a - b) * 1.0 / a * 100 — operand order verbatim; NaN/Infinity
// from zero TVs fail every band test, matching the IL's unordered branches.
function pct(a: number, b: number): number {
  return (((a - b) * 1.0) / a) * 100
}

// Port of CalculationHI. Appends after the apneas (vendor list order).
function scoreHypopneas(table: BreathTable, events: ScoredEvent[]): void {
  const { count, insp, exp, tv } = table
  const n3 = count - 3
  for (let k = 2; k < n3; k++) {
    const r1 = pct(tv[k - 1]!, tv[k]!)
    const r2 = pct(tv[k - 2]!, tv[k]!)
    if (!(r1 > 30 && r1 < 70 && r2 > 30 && r2 < 70)) continue
    const start = insp[k]!
    for (let j = k; j < n3; j++) {
      const r3 = pct(tv[j + 1]!, tv[j]!)
      if (r3 > 30 && r3 < 70) {
        const len16 = (exp[j]! - start) & 0xffff
        if (Math.trunc(len16 / 10) > 9.5) {
          events.push({ kind: 'HYP', start, len: len16 })
          k = j // outer resumes at j + 1
        }
        break
      }
      const r4 = pct(tv[k - 1]!, tv[j]!)
      if (r4 < 30 || r4 > 70) break
      if (Math.trunc((insp[j]! - start) / 10) > 25) break
    }
  }
}
```

and call `scoreHypopneas(table, events)` in `scoreEvents` just before `return events`.

- [ ] **Step 4: Run** — `pnpm vitest run src/parse/events.test.ts && pnpm typecheck && pnpm lint` → PASS.

- [ ] **Step 5: Commit** — `feat: hypopnea scoring port of CalculationHI`

---

### Task 3: `ahiScored` (`GetAI` mAI arithmetic)

**Files:**

- Modify: `src/parse/events.ts`
- Modify: `src/parse/events.test.ts` (append)

**Interfaces:**

- Produces: `ahiScored(events: ScoredEvent[], pressSmooth: Float32Array): number` — Task 4 wires it into `buildNight` with the same padded `pressSmooth` used by `reduceBreaths`.

- [ ] **Step 1: Write the failing tests** (append):

```ts
import { ahiScored } from './events'

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
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** in `events.ts` (import `HZ` from `../types`):

```ts
// Port of GetAI's mAI: apneas only, per hour of non-zero smoothed-pressure
// samples, minus 5 minutes when over 20 minutes, truncated to one decimal.
export function ahiScored(
  events: ScoredEvent[],
  pressSmooth: Float32Array
): number {
  let apneas = 0
  for (const e of events) if (e.kind !== 'HYP') apneas++
  let valid = 0
  for (let i = 0; i < pressSmooth.length; i++) if (pressSmooth[i] !== 0) valid++
  if (valid === 0) return 0 // vendor cannot reach this with a real block
  if (valid > 60 * HZ * 20) valid -= 60 * HZ * 5
  return Math.trunc((apneas * 360000) / valid) / 10
}
```

- [ ] **Step 4: Run** — events tests + typecheck + lint → PASS.

- [ ] **Step 5: Commit** — `feat: scored AHI arithmetic port of GetAI`

---

### Task 4: `buildNight` integration

**Files:**

- Modify: `src/parse/metrics.ts` (replace the Task 1 placeholders)
- Modify: `src/parse/metrics.test.ts` (append)
- Modify: `src/parse/worker.test.ts` (extend the null-fields assertion)

**Interfaces:**

- Consumes: `scoreEvents`/`ahiScored` (Tasks 1–3), the existing `breathTable`/`pressSmooth` locals in `buildNight`.
- Produces: `Night.scored` / `Night.ahiScored` populated; null together with `breath`.

- [ ] **Step 1: Write the failing tests.** Append to `src/parse/metrics.test.ts` (the `squareRaw` helper already exists there):

```ts
test('buildNight attaches scored events and AHI for a long night', () => {
  const night = buildNight('11082026', [squareRaw(12000)], false)
  // square breathing has 2 s pauses — no events, but the machinery runs
  expect(night.scored).not.toBeNull()
  expect(night.scored).toHaveLength(0)
  expect(night.ahiScored).toBe(0)
})

test('buildNight: short night leaves scored fields null', () => {
  const night = buildNight('11082026', [squareRaw(1000)], false)
  expect(night.scored).toBeNull()
  expect(night.ahiScored).toBeNull()
})
```

To `src/parse/worker.test.ts`, extend the existing short-night test with:

```ts
expect(res.night.scored).toBeNull()
expect(res.night.ahiScored).toBeNull()
```

- [ ] **Step 2: Run to verify the first test fails** (`scored` is still the placeholder null).

- [ ] **Step 3: Implement.** In `metrics.ts` import `ahiScored, scoreEvents` from `./events`. After the `breathMetrics` line add:

```ts
const scored = breathMetrics ? scoreEvents(breathTable) : null
```

and replace the placeholder fields in the return object:

```ts
scored,
ahiScored: scored ? ahiScored(scored, pressSmooth) : null,
```

- [ ] **Step 4: Run the full suite** — `pnpm vitest run && pnpm typecheck && pnpm lint` → PASS (all pre-existing tests untouched).

- [ ] **Step 5: Frozen-behavior check (real data):** `make test-diff DS1_DIR=~/Downloads/dreamsleep && make test-reports DS1_DIR=~/Downloads/dreamsleep` — test-diff 2/2; test-reports exactly 6 passed / 1 failed (the documented assertion 7). If anything else moved, stop and fix before committing.

- [ ] **Step 6: Commit** — `feat: attach scored events and AHI to Night`

---

### Task 5: EVT5 reader + per-event oracle + Makefile

**Files:**

- Create: `src/test/evt5.ts`
- Create: `src/test/evt5.test.ts`
- Create: `src/test/events.test.ts` (note: `src/parse/events.test.ts` is the synthetic CI file; this one is the opt-in oracle — different directories, mirroring v1's split)
- Modify: `Makefile` (add `test-events`, extend `.PHONY`)
- Possibly modify: `tools/reports-to-json.py` (plan ruling 2 — only if `expected.json` lacks daily `ahi`/`osa`/`csa` or per-night `ahi`/`apnea`)

**Interfaces:**

- Produces: `readEvt5(buf: ArrayBuffer): Evt5Event[]` with `Evt5Event = { order: number; startMs: number; lenMs: number; type: number; validation: number; blockId: number }`; `make test-events DS1_DIR=...`.

- [ ] **Step 1: Write the reader test.** `src/test/evt5.test.ts` builds a synthetic file: 4096-byte header + three 20-byte records via `DataView` (little-endian: uint16 order at +0, int64 start at +2, int32 len at +10, uint8 type at +14, uint8 validation at +15, uint16 blockId at +16), the middle record with `validation = 2`. Assert `readEvt5` returns two events, in order, with all fields decoded, and that a header-only buffer returns `[]`.

```ts
import { expect, test } from 'vitest'
import { readEvt5 } from './evt5'

function rec(
  dv: DataView,
  off: number,
  e: {
    order: number
    startMs: number
    lenMs: number
    type: number
    validation: number
    blockId: number
  }
): void {
  dv.setUint16(off, e.order, true)
  dv.setBigInt64(off + 2, BigInt(e.startMs), true)
  dv.setInt32(off + 10, e.lenMs, true)
  dv.setUint8(off + 14, e.type)
  dv.setUint8(off + 15, e.validation)
  dv.setUint16(off + 16, e.blockId, true)
}

test('readEvt5 decodes records after the 4096-byte header, dropping validation=2', () => {
  const buf = new ArrayBuffer(4096 + 60)
  const dv = new DataView(buf)
  rec(dv, 4096, {
    order: 0,
    startMs: 774200,
    lenMs: 14200,
    type: 0x15,
    validation: 0,
    blockId: 1,
  })
  rec(dv, 4116, {
    order: 1,
    startMs: 900000,
    lenMs: 10000,
    type: 0x17,
    validation: 2,
    blockId: 0,
  })
  rec(dv, 4136, {
    order: 2,
    startMs: 1200000,
    lenMs: 12000,
    type: 0x16,
    validation: 0,
    blockId: 1,
  })
  const evs = readEvt5(buf)
  expect(evs).toHaveLength(2)
  expect(evs[0]).toEqual({
    order: 0,
    startMs: 774200,
    lenMs: 14200,
    type: 0x15,
    validation: 0,
    blockId: 1,
  })
  expect(evs[1]!.type).toBe(0x16)
  expect(readEvt5(new ArrayBuffer(4096))).toHaveLength(0)
})
```

- [ ] **Step 2: Run to verify it fails,** then implement `src/test/evt5.ts`:

```ts
// Minimal reader for the vendor's .EVT5 event files (spec, "EVT5 file
// layout"): 4096-byte header, then 20-byte little-endian records. Mirrors
// ReloadEvents + FindEvents: all records in order, minus iValidation == 2.
// Test-only — never imported by shipped code.
export type Evt5Event = {
  order: number
  startMs: number
  lenMs: number
  type: number
  validation: number
  blockId: number
}

export function readEvt5(buf: ArrayBuffer): Evt5Event[] {
  const dv = new DataView(buf)
  const out: Evt5Event[] = []
  for (let off = 4096; off + 20 <= buf.byteLength; off += 20) {
    const e = {
      order: dv.getUint16(off, true),
      startMs: Number(dv.getBigInt64(off + 2, true)),
      lenMs: dv.getInt32(off + 10, true),
      type: dv.getUint8(off + 14),
      validation: dv.getUint8(off + 15),
      blockId: dv.getUint16(off + 16, true),
    }
    if (e.validation !== 2) out.push(e)
  }
  return out
}
```

Run to verify it passes.

- [ ] **Step 3: Check `expected.json` coverage** (plan ruling 2): `python3 -c "import json; d=json.load(open('$HOME/Downloads/dreamsleep/expected.json')); print('daily keys', sorted(d['daily'].keys())); print('night keys', sorted(d['nights'][0].keys()))"`. Needed: `nights[].ahi`, `nights[].apnea`, `daily.ahi`, `daily.osa`, `daily.csa`. If missing, extend `tools/reports-to-json.py` (the daily report prints the AHI and the OSA/CSA counts; run `--dump` to find the labels, extend SELFCHECK with the spec-quoted `("daily","ahi"): 2.5, ("daily","osa"): 14, ("daily","csa"): 5`), regenerate, and confirm SELFCHECK passes.

- [ ] **Step 4: Write the oracle test.** `src/test/events.test.ts`, mirroring `reports.test.ts`'s opt-in scaffold (env `DS1_DIR`, `describe.skip` without it, chunk-truncated reads, the `report-snapshot/<file>.snapshot` override is NOT used here — the `.EVT5`s were generated from the current files):

```ts
// Opt-in per-event oracle: our scorer vs the vendor's own .EVT5 output.
//   make test-events DS1_DIR=~/Downloads/dreamsleep
// The .EVT5s were written by the vendor over chunk-truncated reads, so the
// harness truncates the same way (viewer keeps whole files).
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildNight } from '../parse/metrics'
import { parseDs1 } from '../parse/ds1'
import type { Night, ScoredKind } from '../types'
import { readEvt5 } from './evt5'

const KIND_BY_TYPE: Record<number, ScoredKind> = {
  0x15: 'OSA',
  0x16: 'CSA',
  0x17: 'HYP',
}

const dir = process.env['DS1_DIR']?.replace(/^~/, process.env['HOME'] ?? '')
const d = dir ? describe : describe.skip

d('scored events vs vendor .EVT5', () => {
  if (!dir) return
  const dataDir = resolve(dir)
  const nights: Array<{ stem: string; night: Night; evtPath: string }> = []
  for (const f of readdirSync(dataDir).filter((f) => f.endsWith('.ds1'))) {
    const stem = f.replace(/\.ds1$/, '')
    const evtPath = join(dataDir, `${stem}.EVT5`)
    if (!existsSync(evtPath)) continue
    const buf = readFileSync(join(dataDir, f))
    const chunked = Math.floor(buf.byteLength / 4096) * 4096
    const { sessions, partial } = parseDs1(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + chunked),
      f
    )
    nights.push({ stem, night: buildNight(stem, sessions, partial), evtPath })
  }

  test('per-event equality: type, start, duration, file order', () => {
    let compared = 0
    for (const { stem, night, evtPath } of nights) {
      const evt = readFileSync(evtPath)
      const expected = readEvt5(
        evt.buffer.slice(evt.byteOffset, evt.byteOffset + evt.byteLength)
      )
      const ours = night.scored ?? []
      expect(ours.length, `${stem} count`).toBe(expected.length)
      for (let i = 0; i < expected.length; i++) {
        const e = expected[i]!
        const o = ours[i]!
        expect(o.kind, `${stem}[${i}] kind`).toBe(KIND_BY_TYPE[e.type])
        expect(o.start * 100, `${stem}[${i}] start`).toBe(e.startMs)
        expect(o.len * 100, `${stem}[${i}] len`).toBe(e.lenMs)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(2500) // corpus holds 3042 events
  })

  test('report cross-check: per-night apnea count and AHI', () => {
    const expected = JSON.parse(
      readFileSync(join(dataDir, 'expected.json'), 'utf8')
    ) as {
      daily: { date: string; ahi: number; osa: number; csa: number }
      nights: Array<{ date: string; ahi: number; apnea: number }>
    }
    const byDate = new Map(
      nights.map(({ night }) => {
        const dt = night.date
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
        return [key, night] as const
      })
    )
    for (const row of expected.nights) {
      const n = byDate.get(row.date)
      expect(n, `night ${row.date}`).toBeDefined()
      if (!n) continue
      const apneas = (n.scored ?? []).filter((e) => e.kind !== 'HYP').length
      expect(apneas, `${row.date} apnea count`).toBe(row.apnea)
      expect(n.ahiScored, `${row.date} AHI`).toBe(row.ahi)
    }
    const daily = byDate.get(expected.daily.date)!
    const sc = daily.scored ?? []
    expect(sc.filter((e) => e.kind === 'OSA')).toHaveLength(expected.daily.osa)
    expect(sc.filter((e) => e.kind === 'CSA')).toHaveLength(expected.daily.csa)
  })
})
```

Note the 13/08 subtlety: the statistical report's row describes the file as of report
generation, but the current `13082026.ds1` has extra sessions and its `.EVT5` was
generated from the current file. The per-event test uses the `.EVT5` (current file —
consistent). The report cross-check may therefore fail on 2026-08-13 for legitimate
reasons; if it does, exclude that date from the report cross-check loop with a comment
citing this paragraph, and note it in the Task 6 report. Do NOT exclude it from the
per-event test.

- [ ] **Step 5: Makefile.** After `test-reports` add (and extend `.PHONY`):

```make
test-events: ## Scored-event oracle vs vendor .EVT5 files: make test-events DS1_DIR=~/Downloads/dreamsleep
	DS1_DIR=$(DS1_DIR) pnpm vitest run src/test/events.test.ts
```

- [ ] **Step 6: Verify plumbing** — `pnpm vitest run` (oracle skips cleanly), `pnpm typecheck && pnpm lint`. Then run `make test-events DS1_DIR=~/Downloads/dreamsleep` once and record the raw outcome in your report — failures are EXPECTED at this stage and are Task 6's input, not your bug.

- [ ] **Step 7: Commit** — `test: EVT5 reader and per-event scored-event oracle`

---

### Task 6: Oracle reconciliation (requires real data)

**Files:** none new — iterate on `src/parse/events.ts` (and only with a spec-cited fidelity reason on `breath.ts`/`metrics.ts`), plus the spec's Validation outcome.

- [ ] **Step 1:** `make test-events DS1_DIR=~/Downloads/dreamsleep`. The per-event test is the gate; do not debug the report cross-check until per-event equality holds.

- [ ] **Step 2: If events mismatch, debug from the specific failing events** — the assertion message names night and index. The likely failure modes, in order:
  1. **Off-by-one in file order/indexing** — check the first failing index (0 = systematic, mid-list = event-specific).
  2. **`iNextInsp` vs raw next-inspiration** at merge/gap sites — the gate uses the compensated pause, the length the raw index (spec, "Details that matter").
  3. **Chunk-truncation tail** — a missing/extra final event on some nights.
  4. **Band boundary semantics** — open vs closed intervals; re-check against the spec before touching code.
     Never adjust a constant to make a night pass; every change must cite the spec's algorithm text, and if the spec is wrong, fix the spec first (with an IL re-read).
- [ ] **Step 3: Report cross-check.** Settles spec uncertainty #1: if any night's printed AHI ≠ `ahiScored`, compute the unrounded `mOSAIndex + mCSAIndex` candidate for that night in a scratch script and record in the spec which one the report prints. The 13/08 exclusion note from Task 5 applies.
- [ ] **Step 4: Record the outcome** — append a dated "Validation outcome" section to the spec: per-event result (n of 3042), cross-check result, any exclusions with reasons, uncertainty #1's resolution.
- [ ] **Step 5: Full regression** — `pnpm vitest run && make test-diff DS1_DIR=~/Downloads/dreamsleep && make test-reports DS1_DIR=~/Downloads/dreamsleep && make test-events DS1_DIR=~/Downloads/dreamsleep` — all at their expected states (test-reports stays 6/7).
- [ ] **Step 6: Commit** — `fix: reconcile event scorer against EVT5 oracle` (plus the spec edit; only if changes were needed — otherwise commit just the spec's Validation outcome).

---

### Task 7: UI — scored AHI, event lanes, waveform spans

**Files:**

- Modify: `src/state.ts` (`kpis`), `src/state.test.ts`
- Modify: `src/ui/Summary.tsx` (AHI KPI + rewritten `AHI_TIP`)
- Modify: `src/ui/NightTable.tsx` (AHI + apnea columns, sort accessors)
- Modify: `src/ui/App.tsx:157-159` (trend AHI accessor)
- Modify: `src/ui/NightDetail.tsx` (`EventChart` lanes)
- Modify: `src/ui/Waveform.tsx` (flow-pane spans)

**Interfaces:**

- Consumes: `Night.scored`, `Night.ahiScored`; `placeSessions` for the padded-timeline → wall-clock mapping (`xSec = placeSessions(night)[0].offsetSec + e.start / 10`; the padded timeline starts at the first session's start).

- [ ] **Step 1: kpis TDD.** Append to `src/state.test.ts`:

```ts
test('kpis prefers the scored AHI and falls back to device flags', () => {
  const a = { ...night('01082026', 2026, 8, 1), ahi: 9, ahiScored: 2.5 }
  const b = { ...night('02082026', 2026, 8, 2), ahi: 3, ahiScored: null }
  expect(kpis([a, b]).avgAhi).toBeCloseTo((2.5 + 3) / 2, 9)
})
```

Run (fails: current avgAhi averages `n.ahi` → (9+3)/2). Implement in `state.ts`:
`avgAhi: avg((n) => n.ahiScored ?? n.ahi),`. Run to green.

- [ ] **Step 2: Summary.** Rewrite `AHI_TIP`:

```ts
const AHI_TIP =
  'The Apnea-Hypopnea Index (AHI) is the average number of breathing ' +
  'pauses per hour of sleep. Under 5 is normal, 5 to 14 mild, 15 to 29 ' +
  'moderate, 30 or more severe. This figure is estimated by this viewer ' +
  "using the vendor's own scoring: obstructive and central apneas " +
  'detected from the flow channel, per hour of mask-on time. Hypopneas ' +
  'are detected and shown on the night page but, matching the vendor, ' +
  'not counted into the AHI. Nights without enough data fall back to ' +
  "the device's own apnea flags."
```

Wrap the KPI's value in `<Estimated>` only when at least one visible night has
`ahiScored !== null` (compute `const anyScored = nights.some((n) => n.ahiScored !== null)`;
plain value otherwise). One popup per element: the value keeps the `<Estimated>` marker,
the label keeps the ⓘ with `AHI_TIP` (this mirrors the breath-table pattern where the
header carries the tooltip — keep the ⓘ, drop `<Estimated>`'s tooltip by wrapping only
if it doesn't double up; if both would show, prefer the ⓘ alone with the estimated
wording inside `AHI_TIP`, i.e. NO `<Estimated>` wrapper — the tip text above already
says "estimated by this viewer").

Decision (to avoid re-litigating the double-popup bug): **do not wrap the AHI value in
`<Estimated>`; the rewritten `AHI_TIP` on the ⓘ carries the estimate disclosure**, same
resolution as the HP P90/P95 cell.

- [ ] **Step 3: NightTable.** Sort accessor `ahi: (n) => n.ahiScored ?? n.ahi`; add
      accessor `apnea: (n) => n.scored ? n.scored.filter((e) => e.kind !== 'HYP').length : n.events.apnea`
      (check the current `apnea` accessor name at `NightTable.tsx:20-25` and match it).
      Cells:

```tsx
<td>{(n.ahiScored ?? n.ahi).toFixed(1)}</td>
<td
  data-tooltip={n.scored ? `device flags: ${n.events.apnea}` : undefined}
>
  {n.scored
    ? n.scored.filter((e) => e.kind !== 'HYP').length
    : n.events.apnea}
</td>
```

- [ ] **Step 4: Trend.** `src/ui/App.tsx` AHI chart: `value={(n) => n.ahiScored ?? n.ahi}`.

- [ ] **Step 5: EventChart lanes.** In `NightDetail.tsx`:
  - `LANES` becomes six rows (top to bottom): scored `OSA` (row 5, `#c33`), `CSA`
    (row 4, `#8338ec`), `hypopnea` (row 3, `#e8a33d`), device `apnea (device)`
    (row 2, `#c3333388` or the current red), `press up` (row 1), `press down` (row 0).
    Chart height 200, y range `[0, 6]`.
  - Scored events render as spans: in the draw hook, for each scored event compute
    `x0 = u.valToPos(off0 + e.start / 10, 'x', true)`, `x1 = u.valToPos(off0 + (e.start + e.len) / 10, 'x', true)`
    where `off0 = placeSessions(night)[0]?.offsetSec ?? 0`, and fill a lane-height bar
    from x0 to max(x1, x0 + 2·dpr). Device events keep their 2px ticks.
  - Tooltip: include the scored event's kind and duration
    (`${kind}: ${(e.len / 10).toFixed(1)}s`).
  - Title: `events — scored (estimated) · device-flagged`. Footer line adds the scored
    counts: `N OSA · N CSA · N hypopnea (scored) · N apnea (device) · …`.
  - When `night.scored` is null, render exactly the current three-lane chart (guard the
    lane list on `night.scored !== null`).
- [ ] **Step 6: Waveform spans.** In `Waveform.tsx`, next to the existing apnea-mark
      plumbing (`apneas` array built in `NightDetail`/`Waveform` around lines 96-169 and
      drawn at ~283-296): build `spans = (night.scored ?? []).map((e) => ({ from: off0 + e.start / 10, to: off0 + (e.start + e.len) / 10, label: `${e.kind === 'HYP' ? 'hypopnea' : e.kind}: ${(e.len / 10).toFixed(1)}s` }))`
      with the same `off0` as above, thread it to the flow pane like `apneas`, and in the
      flow pane's draw hook, for spans overlapping the window draw a horizontal line at
      ~12 px below the pane top between the two x positions, short end-caps, and the
      label text just above the line (`ctx.fillText`, current axis font, theme stroke
      `#8338ec` for CSA / `#c33` for OSA / `#e8a33d` for hypopnea). Skip the label when
      the span is narrower than the measured text.
- [ ] **Step 7: Verify** — `pnpm vitest run && pnpm typecheck && pnpm lint && make build` (bundle < 800 KB). Then `make dev`, drop the corpus folder, and eyeball: summary AHI ≈ vendor-like values, night page lanes and spans on a night with events, tooltips, and the null path (tiny file).
- [ ] **Step 8: Commit** — `feat: surface scored events and AHI in the UI`

---

### Task 8: Definition of done

- [ ] **Step 1:** `make typecheck && make test && make lint && make build` — green, bundle under 800 KB.
- [ ] **Step 2:** `make test-diff DS1_DIR=~/Downloads/dreamsleep` — 2/2; `make test-reports DS1_DIR=~/Downloads/dreamsleep` — exactly 6 passed / 1 failed (the documented assertion 7).
- [ ] **Step 3:** `make test-events DS1_DIR=~/Downloads/dreamsleep` — green, or the spec documents the specific exceptions.
- [ ] **Step 4:** Greps: no `Math.round` in `src/parse/events.ts`; no `any` in `src/`; `readEvt5` imported only from test files.
- [ ] **Step 5:** Report results with actual command output; the user decides on merging.
