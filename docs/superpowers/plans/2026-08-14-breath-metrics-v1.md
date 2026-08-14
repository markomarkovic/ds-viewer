# Breath-Derived Metrics v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the vendor's breath segmentation of the flow channel and the deterministic reductions it unlocks — expiratory P90/P95, tidal volume, respiratory rate, I:E, minute ventilation, per-breath leakage — validated against the two saved vendor reports.

**Architecture:** A new pure module `src/parse/breath.ts` (segmentation + reduction) over concatenated night-level `Float32Array` channels, sharing filters with `metrics.ts` via a new `src/parse/signal.ts`. `buildNight` attaches the results to `Night`; the UI marks every new number as an estimate. Oracle values are extracted from the vendor's `.docx` reports by a committed Python tool into an out-of-repo `expected.json`, asserted by an opt-in test.

**Tech Stack:** TypeScript (Preact/uPlot app, Vitest), Python 3 stdlib for the report extractor.

**Spec:** `docs/superpowers/specs/2026-08-14-breath-metrics-v1-design.md` (implements the deterministic half of `docs/superpowers/specs/2026-08-14-breath-metrics-design.md`).

## Global Constraints

- No `any`; branded unit types throughout; `import type { ... }` for type-only imports; Prettier clean (`make lint`).
- Bundle budget: `make build` fails above 800 KB — check after the UI task.
- Real recordings and values derived from them never enter the repo. Oracle tests are opt-in on `DS1_DIR`, mirroring `src/test/differential.test.ts`.
- **Vendor-port numerics (spec, "Details that matter"):** never use `Math.round` in ported code — .NET `Math.Round` is round-half-to-even; use the `roundHalfEven` helper. Vendor arithmetic is `float32`: apply `Math.fround` (or store through `Float32Array`) wherever the vendor stores a value back. Truncation (`Math.trunc`) is load-bearing and applied at the vendor's point in the pipeline, not at display time.
- Apnea/hypopnea scoring, OSA/CSA, AHI re-scoring, waveform event marking: **out of scope** (follow-on spec).
- Existing behaviour frozen: `press.avg/median/p90/p95/max`, `leakMedian`, and everything `make test-diff` covers must not change.
- Oracle tolerances (spec table) start at the strictest value; loosening one requires a stated reason recorded in the spec, not a passing test.
- Git: commit at the marked checkpoints **only if the user has explicitly authorized commits for this execution session**; otherwise stop at the checkpoint and report. Never add Co-Authored-By or any AI attribution.

## Spec Reconciliation (decisions locked by this plan)

Resolutions to the inconsistencies and gaps found when checking the two specs against each other and the code. Tasks below argue from these.

1. **Parent-spec corrections stand.** The v1 spec explicitly supersedes the parent on three points (P90/P95 sample-pool definition, TV threshold `baseline + 3`, effective duration = recorded duration). Implement v1.
2. **`Avg` formula:** the spec's table says `trunc(mean)` but the text gives the vendor's exact code, `(int)Math.Round(mean, 2)`. The exact formula wins: `Math.trunc(roundHalfEven(mean × 100) / 100)`.
3. **`InsMaxPress`/`ExpMinPress` dead stores:** the reduction pseudocode writes them but `BreathTable` has no arrays for them and no `BreathMetrics` field reads them (`expPress.min`/`inspPress.max` come from the sample pools + `CalPress` bounds). They are omitted entirely — no observable value depends on them. Same for `prev.iMV` in segmentation: the reduction recomputes `iBPM × iTV`, so `iMV` is never stored.
4. **Null rule:** "Both are null for recordings under ~10 minutes" wins — when `reduceBreaths` returns `null`, `Night.breath` **and** `Night.breaths` are both `null`. Otherwise both are set.
5. **Leak rounding (spec leaves it open):** apply the same list discipline as every other metric — `percentileVendor` / `vendorAvg` over the raw-count list — then convert once via `lpm()`. The oracle asserts leak at ±0.2 L/min, which absorbs the unknown vendor UI conversion.
6. **Type placement:** `Ml`, `BreathTable`, `BreathMetrics` live in `src/types.ts` (the `Night` type must reference them; `breath.ts` imports them type-only). The `Ml` brand assertion goes in `src/types.brands.ts`.
7. **`Estimated` wrapper file** (unnamed in spec): `src/ui/Estimated.tsx`, plus an `.estimated` rule in `src/app.css`.
8. **Summary layout:** the 5-KPI grid keeps 5 cells; the `avg P95` cell becomes the estimated "HP P90/P95" pair, with the channel-exact sample-stream average P95 moved into its tooltip (per spec: sample percentiles move to the tooltip).
9. **Last-breath contribution** (spec conflates two cases): a closed-but-last breath (`iExp > 0`, `iNextInsp = 0`) contributes a negative I:E; a breath open at end-of-recording (`iExp = 0`) contributes `-0`. Both fall out of implementing the pseudocode literally; neither is filtered.
10. **`GetFlowBlock`** is named in the spec but never described; its role (zero-filled inter-session blanks) is deliberately not ported — the "Session gaps" deviation covers it, and Task 7 holds the fallback.

---

### Task 1: `src/parse/signal.ts` — shared numeric helpers

**Files:**

- Create: `src/parse/signal.ts`
- Create: `src/parse/signal.test.ts`
- Modify: `src/parse/metrics.ts` (remove `lowpass`/`median`, import from signal)
- Modify: `src/parse/metrics.test.ts` (import path only)

**Interfaces:**

- Consumes: nothing new.
- Produces (for Tasks 3–5):
  - `lowpass(x: ArrayLike<number>, a: number): Float64Array` — moved verbatim, current callers keep it.
  - `lowpassF32(x: ArrayLike<number>, a: number): Float32Array` — same two-pass filter, f32 storage.
  - `median(sorted: Float64Array): number` — moved verbatim.
  - `percentileVendor(sorted: Float32Array, p: number): number` — vendor `Percentile`; precondition: sorted ascending, non-empty.
  - `roundHalfEven(x: number): number` — .NET `Math.Round` semantics.

- [ ] **Step 1: Write the failing tests**

Create `src/parse/signal.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  lowpass,
  lowpassF32,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/parse/signal.test.ts`
Expected: FAIL — cannot resolve `./signal`.

- [ ] **Step 3: Implement `src/parse/signal.ts`**

Move `lowpass` and `median` out of `metrics.ts` **verbatim** (cut, do not retype). Add:

```ts
export function lowpassF32(x: ArrayLike<number>, a: number): Float32Array {
  const k = Math.fround(a / 100)
  const y = Float32Array.from(x)
  if (y.length === 0) return y
  let prev = y[0]!
  for (let i = 0; i < y.length; i++) {
    y[i] = prev * (1 - k) + y[i]! * k // Float32Array store rounds to f32
    prev = y[i]!
  }
  prev = y[y.length - 1]!
  for (let i = y.length - 1; i >= 0; i--) {
    y[i] = prev * (1 - k) + y[i]! * k
    prev = y[i]!
  }
  return y
}

/** .NET Math.Round: round half to even (banker's rounding). */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x)
  const diff = x - f
  if (diff < 0.5) return f
  if (diff > 0.5) return f + 1
  return f % 2 === 0 ? f : f + 1
}

/**
 * Vendor Percentile helper: element floor(n*p/100) of the ascending-sorted
 * list, truncated to int. Precondition: sorted, non-empty. The index is not
 * clamped; callers only pass p in {50, 90, 95}.
 */
export function percentileVendor(sorted: Float32Array, p: number): number {
  return Math.trunc(sorted[Math.floor((sorted.length * p) / 100)]!)
}
```

In `metrics.ts`, add `import { lowpass, median } from './signal'` (value import — they are called). In `metrics.test.ts`, split the import: `accumulateHistogram, buildNight, percentileDeci` from `./metrics`; `lowpass, median` from `./signal`. `percentileDeci` and `accumulateHistogram` stay in `metrics.ts`.

- [ ] **Step 4: Run the full suite**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all tests pass (existing `lowpass matches ds1.py bit-for-bit` fixtures included).

- [ ] **Step 5: Checkpoint / commit (only if authorized)**

Suggested message: `refactor: extract shared signal helpers into src/parse/signal.ts`

---

### Task 2: Types — `Ml`, `BreathTable`, `BreathMetrics`, nullable `Night` fields

**Files:**

- Modify: `src/types.ts`
- Modify: `src/types.brands.ts`
- Modify: `src/parse/metrics.ts:105-123` (`buildNight` return — temporary nulls)
- Modify: `src/state.test.ts:6` (the `night()` literal)

**Interfaces:**

- Produces (exact shapes Tasks 3–5 and 8 rely on):

```ts
export type Ml = Brand<number, 'Ml'> // millilitres
export const ml = (n: number): Ml => n as Ml

export type BreathTable = {
  count: number
  insp: Int32Array // sample index, night-relative
  exp: Int32Array
  nextInsp: Int32Array
  tv: Int32Array // mL
  bpm: Float32Array // breaths/min
  leak: Float32Array // raw counts
}

export type BreathMetrics = {
  breaths: number // breaths after the 5-min trim
  expPress: { avg: Deci; min: Deci; p90: Deci; p95: Deci }
  inspPress: { avg: Deci; max: Deci; p90: Deci; p95: Deci }
  tv: { avg: Ml; p50: Ml; p90: Ml; p95: Ml }
  bpm: { avg: number; p50: number; p90: number; p95: number }
  ie: { avg: number; p50: number; p90: number; p95: number }
  mv: { avg: Ml; p50: Ml; p90: Ml; p95: Ml } // mL/min
  leak: { avg: Lpm; p50: Lpm; p90: Lpm; p95: Lpm }
}
```

`Night` gains:

```ts
breath: BreathMetrics | null // null when the 5-min trims leave no breaths
breaths: BreathTable | null // retained for the event-scoring follow-on
```

- [ ] **Step 1: Add the types to `src/types.ts`** exactly as above (`Ml`/`ml` next to the other brands, the two structs above `Night`, the two fields at the end of `Night`).

- [ ] **Step 2: Make it compile.** In `buildNight`'s return object add `breath: null, breaths: null` (Task 5 replaces these). In `src/state.test.ts`, the `night()` helper's object literal gains `breath: null, breaths: null`.

- [ ] **Step 3: Extend the brand assertion.** In `src/types.brands.ts` add `Ml` to the import, `declare const m: Ml`, and:

```ts
// @ts-expect-error Ml is not Lpm
const bad5: Lpm = m
```

Append `typeof bad5` to `_keep`.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm vitest run`
Expected: green.

- [ ] **Step 5: Checkpoint / commit (only if authorized)**

Suggested message: `feat: add breath-metric types and nullable Night fields`

---

### Task 3: `segmentBreaths` — port of `CalIsnpExp`

**Files:**

- Create: `src/parse/breath.ts`
- Create: `src/parse/breath.test.ts`

**Interfaces:**

- Consumes: `roundHalfEven` from `./signal`; `BreathTable` from `../types` (type-only).
- Produces: `segmentBreaths(flowSmooth: Float32Array, flowBase: Float32Array): BreathTable`. Indices are night-relative into the concatenated arrays. The last breath is never finalized (`nextInsp`/`bpm` stay 0; an open breath also has `exp = 0`, `tv = 0`).

- [ ] **Step 1: Write the failing tests**

Create `src/parse/breath.test.ts`. Index derivation for the square generator: lead-in occupies indices `0..39`; a crossing fires at the **sample before** a block boundary (conditions read `n-1` and `n+1`), so a block starting at index `s` yields `iInsp = s − 1`, and an expiration block starting at `e` yields `iExp = e − 1`. TV for a 20-sample amp-40 inspiration: entry samples at `n = iInsp` and `iInsp+1` both read pre-block flow −40 → `|roundHalfEven(−40 − 3)| = 43` twice; the 19 iterations `n = iInsp+2 .. iExp` read +40 → `|37|` each; `tvAcc = 43·2 + 37·19 = 789`, `iTV = roundHalfEven(789/5 = 157.8) = 158`.

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/parse/breath.test.ts`
Expected: FAIL — `segmentBreaths` not defined.

- [ ] **Step 3: Implement `segmentBreaths` in `src/parse/breath.ts`**

```ts
import type { BreathTable } from '../types'
import { roundHalfEven } from './signal'

type TBreath = {
  iInsp: number
  iExp: number
  iNextInsp: number
  iTV: number
  iBPM: number
  iLeak: number
}

// Port of DP.Analysis.AnalysisFileV2.CalIsnpExp, DataVer==1 (.ds1).
// The vendor's iMV store and the InsMaxPress/ExpMinPress fields are omitted:
// nothing observable reads them (see plan, Spec Reconciliation #3).
export function segmentBreaths(
  flowSmooth: Float32Array,
  flowBase: Float32Array
): BreathTable {
  const breaths: TBreath[] = []
  let inInsp = false
  let armed = true
  let tvAcc = 0
  let zeroRun = 0

  for (let n = 10; n <= flowSmooth.length - 3; n++) {
    const prevFlow = flowSmooth[n - 1]!
    const nextFlow = flowSmooth[n + 1]!
    const prevThr = Math.fround(flowBase[n - 1]! + 3)
    const nextThr = Math.fround(flowBase[n + 1]! + 3)

    if (flowSmooth[n] === 0) zeroRun++

    // rising crossing of the threshold -> inspiration starts
    if (armed && prevThr - prevFlow > 0.1 && nextFlow - nextThr >= 0) {
      inInsp = true
      armed = false
      breaths.push({
        iInsp: n,
        iExp: 0,
        iNextInsp: 0,
        iTV: 0,
        iBPM: 0,
        iLeak: prevFlow,
      })
      const k = breaths.length - 1
      if (k > 0) {
        const prev = breaths[k - 1]!
        prev.iNextInsp = n - zeroRun
        prev.iBPM = Math.fround(600 / (prev.iNextInsp - prev.iInsp))
        zeroRun = 0
      }
    }

    if (inInsp) tvAcc += Math.abs(roundHalfEven(prevFlow - prevThr))
    else tvAcc = 0

    // falling crossing -> expiration starts, closing the breath
    if (inInsp && prevFlow - prevThr > 0.1 && nextThr - nextFlow > 0) {
      inInsp = false
      armed = true
      const cur = breaths[breaths.length - 1]!
      cur.iExp = n
      cur.iTV = roundHalfEven(tvAcc / 5)
    }
  }

  // small-breath merge; indices collected up front, removed in reverse so
  // earlier indices stay valid. The guard re-reads the shrinking length.
  const small: number[] = []
  for (let i = 2; i < breaths.length; i++)
    if (breaths[i]!.iTV <= 20) small.push(i)
  for (let j = small.length - 1; j >= 0; j--) {
    const i = small[j]!
    if (i + 1 >= breaths.length - 1) continue
    breaths[i - 1]!.iNextInsp = breaths[i + 1]!.iInsp
    breaths.splice(i, 1) // iBPM of breaths[i-1] deliberately left stale
  }

  return {
    count: breaths.length,
    insp: Int32Array.from(breaths, (b) => b.iInsp),
    exp: Int32Array.from(breaths, (b) => b.iExp),
    nextInsp: Int32Array.from(breaths, (b) => b.iNextInsp),
    tv: Int32Array.from(breaths, (b) => b.iTV),
    bpm: Float32Array.from(breaths, (b) => b.iBPM),
    leak: Float32Array.from(breaths, (b) => b.iLeak),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/parse/breath.test.ts`
Expected: PASS. If a boundary assertion fails by ±1 sample, re-check the loop bounds (`n = 10 .. length−3` inclusive) and the evaluation order (zero-check, rising, TV accumulation, falling) before touching the expected values — the expected values were hand-traced from the spec pseudocode.

- [ ] **Step 5: Checkpoint / commit (only if authorized)**

Suggested message: `feat: breath segmentation port of CalIsnpExp`

---

### Task 4: `reduceBreaths` — port of `GetInspExpPress` + `CalPress`

**Files:**

- Modify: `src/parse/breath.ts`
- Modify: `src/parse/breath.test.ts`

**Interfaces:**

- Consumes: `BreathTable` (Task 2), `percentileVendor`/`roundHalfEven` (Task 1), `deci`/`ml`/`lpm`/`HZ` from `../types`.
- Produces: `reduceBreaths(table: BreathTable, pressSmooth: Float32Array): BreathMetrics | null` — null when either pressure pool is empty. `MINUTE_DATA = 300 * HZ` exported for tests.

- [ ] **Step 1: Write the failing tests** (append to `src/parse/breath.test.ts`)

```ts
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
  // pressure pools come from r1+r2 only, all samples 55
  expect(m.expPress.p90).toBe(55)
  expect(m.expPress.p95).toBe(55)
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
  expect(m.ie.avg).toBe(25.3) // trunc(roundHalfEven(253.333*100)/100)/10
  // mv = bpm*tv: [3000,3360,2660]
  expect(m.mv.p50).toBe(3000)
  expect(m.mv.avg).toBe(3006) // trunc of mean 3006.67
  // leak counts [120,125,130] -> percentile/trunc, then * FLOW_LPM
  expect(m.leak.p50).toBeCloseTo(15, 6) // 125 * 0.12
  expect(m.leak.avg).toBeCloseTo(15, 6)
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/parse/breath.test.ts`
Expected: FAIL — `reduceBreaths` not exported.

- [ ] **Step 3: Implement in `src/parse/breath.ts`**

Add to the imports: `import type { BreathMetrics } from '../types'` and `import { deci, HZ, lpm, ml } from '../types'`, `percentileVendor` from `./signal`.

```ts
export const MINUTE_DATA = 300 * HZ // head/tail trim, samples

function sortedF32(xs: number[]): Float32Array {
  return Float32Array.from(xs).sort()
}

// vendor Avg: (int)Math.Round(mean, 2) — see plan, Spec Reconciliation #2
function vendorAvg(sorted: Float32Array): number {
  let sum = 0
  for (let i = 0; i < sorted.length; i++) sum += sorted[i]!
  return Math.trunc(roundHalfEven((sum / sorted.length) * 100) / 100)
}

// Port of CalPress: min/max of pressSmooth clamped into [40, 300], first and
// last MINUTE_DATA samples excluded. Does not mutate the array.
function calPressBounds(pressSmooth: Float32Array): {
  min: number
  max: number
} {
  let min = 300
  let max = 40
  for (let i = MINUTE_DATA; i < pressSmooth.length - MINUTE_DATA; i++) {
    const v = Math.min(300, Math.max(40, pressSmooth[i]!))
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min: Math.trunc(min), max: Math.trunc(max) }
}

// Port of DP.Analysis.AnalysisFileV2.GetInspExpPress.
export function reduceBreaths(
  table: BreathTable,
  pressSmooth: Float32Array
): BreathMetrics | null {
  const inspSamples: number[] = []
  const expSamples: number[] = []
  const tvL: number[] = []
  const leakL: number[] = []
  const bpmL: number[] = []
  const mvL: number[] = []
  const ieL: number[] = []

  for (let b = 0; b < table.count; b++) {
    const iInsp = table.insp[b]!
    const iExp = table.exp[b]!
    const iNextInsp = table.nextInsp[b]!
    const tv = table.tv[b]!
    const bpm = table.bpm[b]!
    if (iInsp < MINUTE_DATA) continue

    // appends precede the break test: the breath that ends the loop still
    // contributes to every list except the two pressure pools
    tvL.push(tv)
    leakL.push(table.leak[b]!)
    bpmL.push(Math.fround(bpm * 10))
    mvL.push(Math.fround(bpm * tv))
    ieL.push(Math.fround(((iNextInsp - iExp) / (iExp - iInsp)) * 10))

    const end = Math.min(iNextInsp, pressSmooth.length)
    const inspFrom = iInsp + Math.trunc((iExp - iInsp) / 3)
    const expFrom = iExp + Math.trunc((iNextInsp - iExp) / 3)
    if (end > pressSmooth.length - MINUTE_DATA) break

    for (let i = iInsp; i < end; i++) {
      const p = pressSmooth[i]!
      if (i > inspFrom && i < iExp) inspSamples.push(p)
      if (i > expFrom && i < end && p >= 40) expSamples.push(p)
    }
  }

  if (inspSamples.length === 0 || expSamples.length === 0) return null

  const inspS = sortedF32(inspSamples)
  const expS = sortedF32(expSamples)
  const tvS = sortedF32(tvL)
  const bpmS = sortedF32(bpmL)
  const ieS = sortedF32(ieL)
  const mvS = sortedF32(mvL)
  const leakS = sortedF32(leakL)
  const bounds = calPressBounds(pressSmooth)

  return {
    breaths: tvL.length,
    expPress: {
      avg: deci(vendorAvg(expS)),
      min: deci(Math.max(Math.trunc(expS[0]!), bounds.min)),
      p90: deci(percentileVendor(expS, 90)),
      p95: deci(percentileVendor(expS, 95)),
    },
    inspPress: {
      avg: deci(vendorAvg(inspS)),
      max: deci(Math.min(Math.trunc(inspS[inspS.length - 1]!), bounds.max)),
      p90: deci(percentileVendor(inspS, 90)),
      p95: deci(percentileVendor(inspS, 95)),
    },
    tv: {
      avg: ml(vendorAvg(tvS)),
      p50: ml(percentileVendor(tvS, 50)),
      p90: ml(percentileVendor(tvS, 90)),
      p95: ml(percentileVendor(tvS, 95)),
    },
    bpm: {
      avg: vendorAvg(bpmS) / 10,
      p50: percentileVendor(bpmS, 50) / 10,
      p90: percentileVendor(bpmS, 90) / 10,
      p95: percentileVendor(bpmS, 95) / 10,
    },
    ie: {
      avg: vendorAvg(ieS) / 10,
      p50: percentileVendor(ieS, 50) / 10,
      p90: percentileVendor(ieS, 90) / 10,
      p95: percentileVendor(ieS, 95) / 10,
    },
    mv: {
      avg: ml(vendorAvg(mvS)),
      p50: ml(percentileVendor(mvS, 50)),
      p90: ml(percentileVendor(mvS, 90)),
      p95: ml(percentileVendor(mvS, 95)),
    },
    leak: {
      avg: lpm(vendorAvg(leakS)),
      p50: lpm(percentileVendor(leakS, 50)),
      p90: lpm(percentileVendor(leakS, 90)),
      p95: lpm(percentileVendor(leakS, 95)),
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/parse/breath.test.ts && pnpm typecheck`
Expected: PASS. The `ie.avg` assertion (25.3) is the guard on the `(int)Math.Round(mean,2)` formula — if it reads 25.33 or 25 the avg helper is wrong, not the test.

- [ ] **Step 5: Checkpoint / commit (only if authorized)**

Suggested message: `feat: breath-list reduction port of GetInspExpPress`

---

### Task 5: `buildNight` integration + worker transfer

**Files:**

- Modify: `src/parse/metrics.ts:46-124` (`buildNight`)
- Modify: `src/parse/worker.ts:13-15` (transfer list)
- Modify: `src/parse/metrics.test.ts` (integration tests)
- Modify: `src/parse/worker.test.ts` (transfer + null assertions)

**Interfaces:**

- Consumes: `segmentBreaths`/`reduceBreaths` (Tasks 3–4), `lowpassF32` (Task 1).
- Produces: `Night.breath`/`Night.breaths` populated per Spec Reconciliation #4; worker transfers the six `BreathTable` buffers when non-null.

- [ ] **Step 1: Write the failing tests**

Append to `src/parse/metrics.test.ts` (add `RawSession` to the type imports):

```ts
function squareRaw(sampleCount: number): RawSession {
  const flow = new Uint16Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) flow[i] = i % 40 < 20 ? 140 : 60
  return {
    start: new Date(2026, 7, 11, 22, 0, 0),
    end: new Date(2026, 7, 11, 22, 0, 0 + sampleCount / 10),
    params: new Map(),
    press: new Uint16Array(sampleCount).fill(55),
    flow,
    events: [],
  }
}

test('buildNight attaches breath metrics for a long night', () => {
  const night = buildNight('11082026', [squareRaw(12000)], false)
  expect(night.breaths).not.toBeNull()
  expect(night.breath).not.toBeNull()
  const b = night.breath!
  expect(night.breaths!.count).toBeGreaterThan(200) // ~15 BPM for 20 min
  expect(Math.abs(b.bpm.p50 - 15)).toBeLessThanOrEqual(1)
  expect(Math.abs(b.expPress.p95 - 55)).toBeLessThanOrEqual(1) // constant 5.5
  expect(Math.abs(b.ie.p50 - 1)).toBeLessThanOrEqual(0.2) // 1:1 duty cycle
})

test('buildNight: short night leaves both breath fields null', () => {
  const night = buildNight('11082026', [squareRaw(1000)], false)
  expect(night.breath).toBeNull()
  expect(night.breaths).toBeNull()
})

test('breath metrics unaffected by pre-existing per-session outputs', () => {
  // two sessions concatenate: same totals as one 12000-sample session
  const night = buildNight(
    '11082026',
    [squareRaw(6000), squareRaw(6000)],
    false
  )
  expect(night.breath).not.toBeNull()
  expect(night.press.avg).toBe(55) // frozen existing behaviour
})
```

Append to `src/parse/worker.test.ts` (import `buildDs1, rec` from `../test/encode`):

```ts
test('short night: breath fields null, transfer list unchanged', () => {
  const { res, transfers } = handle({
    id: 2,
    name: '13082026.ds1',
    buf: simpleNight({ sampleCount: 100 }),
  })
  if (!res.ok) throw new Error(res.error)
  expect(res.night.breath).toBeNull()
  expect(res.night.breaths).toBeNull()
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/parse/metrics.test.ts src/parse/worker.test.ts`
Expected: FAIL — `breath` is still hard-coded `null`; transfers are 3.

- [ ] **Step 3: Implement**

In `metrics.ts`, import `lowpassF32` from `./signal` and `reduceBreaths, segmentBreaths` from `./breath`. After the existing per-session loop and `allBase` block in `buildNight` (before the `return`), add:

```ts
// Night-level concatenated channels for the breath port. Deviation from the
// vendor (spec, "Session gaps"): sessions are contiguous, no zero-filled
// wall-clock blanks between them.
const flowAll = new Float32Array(totalSamples)
const pressAll = new Float32Array(totalSamples)
let boff = 0
for (const s of raw) {
  flowAll.set(s.flow, boff)
  pressAll.set(s.press, boff)
  boff += s.press.length
}
const breathTable = segmentBreaths(
  lowpassF32(flowAll, 50),
  lowpassF32(flowAll, 3)
)
const breathMetrics = reduceBreaths(breathTable, lowpassF32(pressAll, 20))
```

In the returned object replace the Task-2 placeholders:

```ts
breath: breathMetrics,
breaths: breathMetrics ? breathTable : null,
```

In `worker.ts`, after the session-buffer loop:

```ts
if (night.breaths) {
  const t = night.breaths
  transfers.push(
    t.insp.buffer,
    t.exp.buffer,
    t.nextInsp.buffer,
    t.tv.buffer,
    t.bpm.buffer,
    t.leak.buffer
  )
}
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS, including all pre-existing tests (frozen behaviour).

- [ ] **Step 5: Run the existing differential harness (requires real data)**

Run: `make test-diff DS1_DIR=~/Downloads/dreamsleep`
Expected: PASS — proves the new stage changed nothing existing. If the machine has no `DS1_DIR` data, mark this step deferred to Task 7 and say so in the report.

- [ ] **Step 6: Checkpoint / commit (only if authorized)**

Suggested message: `feat: attach breath table and metrics to Night; transfer table buffers`

---

### Task 6: Oracle tooling — report extractor, Makefile target, opt-in test

**Files:**

- Create: `tools/reports-to-json.py`
- Create: `src/test/reports.test.ts`
- Modify: `Makefile` (add `test-reports`)

**Interfaces:**

- Consumes: `Night.breath` (Task 5).
- Produces: `$DS1_DIR/expected.json` with the exact schema below; `make test-reports DS1_DIR=...` runs assertions 1–7.

`expected.json` schema (dates ISO `YYYY-MM-DD`; pressures in cmH2O as printed; TV in mL; MV in mL/min; I:E as the x in 1:x):

```json
{
  "daily": {
    "date": "2026-08-11",
    "durationHours": 7.48,
    "press": { "avg": 6.1, "max": 8.5, "min": 4.1, "p90": 6.3, "p95": 6.9 },
    "tv": { "avg": 199, "p50": 196, "p90": 249, "p95": 289 },
    "bpm": { "avg": 15.1, "p50": 15.0, "p90": 18.1, "p95": 19.3 },
    "leak": { "avg": 14.8, "p50": 14.7, "p90": 17.4, "p95": 18.2 },
    "ie": { "p50": 1.2, "p90": 1.5, "p95": 1.7 }
  },
  "nights": [
    {
      "date": "2026-08-01",
      "durationHours": 0,
      "pressAvg": 0,
      "p90": 0,
      "p95": 0,
      "max": 0,
      "ahi": 0,
      "apnea": 0,
      "leakAvg": 0
    }
  ],
  "aggregates": {
    "tv": { "p50": 0, "p90": 0, "p95": 0 },
    "bpm": { "p50": 0, "p90": 0, "p95": 0 },
    "ie": { "p50": 0, "p90": 0, "p95": 0 },
    "mv": { "p50": 0, "p90": 0, "p95": 0 }
  }
}
```

(The zeros above are schema illustration only; the tool writes real extracted values.)

- [ ] **Step 1: Write `tools/reports-to-json.py`**

```python
#!/usr/bin/env python3
"""Extract oracle values from the vendor's saved reports into expected.json.

Usage:
    tools/reports-to-json.py DIR          # DIR holds the two .docx; writes DIR/expected.json
    tools/reports-to-json.py DIR --dump   # print every table for label inspection

Deterministic, stdlib-only, no network. The .docx contain only derived
numbers, no waveform data, but expected.json still lives outside the repo
with the recordings it describes.
"""
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
DATE_RE = re.compile(r"(\d{2})/(\d{2})/(\d{4})")
NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def doc_tables(path: Path) -> list[list[list[str]]]:
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    tables = []
    for tbl in root.iter(f"{W}tbl"):
        rows = []
        for tr in tbl.findall(f"{W}tr"):
            rows.append(
                [
                    "".join(t.text or "" for t in tc.iter(f"{W}t")).strip()
                    for tc in tr.findall(f"{W}tc")
                ]
            )
        tables.append(rows)
    return tables


def dump(tables: list[list[list[str]]], name: str) -> None:
    print(f"==== {name} ====")
    for ti, t in enumerate(tables):
        print(f"-- table {ti} --")
        for r in t:
            print(" | ".join(r))


def cells(tables):
    for t in tables:
        for r in t:
            yield r


def find_row(tables, pattern: str) -> list[str]:
    rx = re.compile(pattern, re.IGNORECASE)
    for r in cells(tables):
        if r and rx.search(r[0]):
            return r
    raise SystemExit(f"no row matching {pattern!r}; run with --dump and fix LABELS")


def numbers(row: list[str]) -> list[float]:
    out: list[float] = []
    for c in row[1:]:
        # I:E prints as "1:1.7" -> keep the x
        c = re.sub(r"\b1:", "", c)
        out.extend(float(m) for m in NUM_RE.findall(c))
    return out


def iso(d: str, m: str, y: str) -> str:
    return f"{y}-{m}-{d}"


def duration_hours(cell: str) -> float:
    hms = re.search(r"(\d+):(\d{2}):(\d{2})", cell)
    if hms:
        h, m, s = (int(g) for g in hms.groups())
        return round(h + m / 60 + s / 3600, 4)
    return float(NUM_RE.search(cell).group(0))


# Row-label patterns, written from the vendor's wording quoted in the spec.
# If a pattern misses the real document, run --dump and adjust the pattern —
# SELFCHECK below is the gate that proves the mapping right.
LABELS = {
    "tv": r"TV|Tidal",
    "bpm": r"BPM|Breath.?Rate|Resp",
    "leak": r"Leak",
    "ie": r"I\s*[:/]\s*E",
    "mv": r"Minute\s*Vol",
    "press_pct": r"Horizontal\s*Pressure|P90",
    "duration": r"Effective\s*Duration|Duration",
}

# Known 11/08 values, straight from the spec; extraction must reproduce them.
SELFCHECK = {
    ("daily", "press", "p90"): 6.3,
    ("daily", "press", "p95"): 6.9,
    ("daily", "tv", "avg"): 199,
    ("daily", "tv", "p95"): 289,
    ("daily", "bpm", "avg"): 15.1,
    ("daily", "bpm", "p95"): 19.3,
    ("daily", "leak", "avg"): 14.8,
    ("daily", "ie", "p95"): 1.7,
    ("daily", "durationHours"): 7.48,
}


def quart(row: list[str]) -> dict:
    # vendor prints Avg then 95/90/50 percent columns
    ns = numbers(row)
    if len(ns) < 4:
        raise SystemExit(f"quartet row too short: {row}")
    avg, p95, p90, p50 = ns[0], ns[1], ns[2], ns[3]
    return {"avg": avg, "p50": p50, "p90": p90, "p95": p95}


def parse_daily(tables) -> dict:
    press_row = numbers(find_row(tables, LABELS["press_pct"]))
    daily = {
        "date": "2026-08-11",
        "durationHours": duration_hours(
            " ".join(find_row(tables, LABELS["duration"]))
        ),
        # Avg, Max, Min, P90, P95 — order per the printed report; verify via --dump
        "press": {
            "avg": press_row[0],
            "max": press_row[1],
            "min": press_row[2],
            "p90": press_row[3],
            "p95": press_row[4],
        },
        "tv": quart(find_row(tables, LABELS["tv"])),
        "bpm": quart(find_row(tables, LABELS["bpm"])),
        "leak": quart(find_row(tables, LABELS["leak"])),
    }
    ie = quart(find_row(tables, LABELS["ie"]))
    del ie["avg"]  # the daily report prints no I:E average
    daily["ie"] = ie
    return daily


def parse_statistical(tables) -> tuple[list[dict], dict]:
    nights = []
    for r in cells(tables):
        m = DATE_RE.search(r[0]) if r else None
        if not m or len(r) < 9:
            continue
        # columns per spec: Duration, Avg Pressure, P90, P95, Max, AHI,
        # Apnea, Avg Leakage — verify order via --dump
        nights.append(
            {
                "date": iso(*m.groups()),
                "durationHours": duration_hours(r[1]),
                "pressAvg": float(NUM_RE.search(r[2]).group(0)),
                "p90": float(NUM_RE.search(r[3]).group(0)),
                "p95": float(NUM_RE.search(r[4]).group(0)),
                "max": float(NUM_RE.search(r[5]).group(0)),
                "ahi": float(NUM_RE.search(r[6]).group(0)),
                "apnea": int(NUM_RE.search(r[7]).group(0)),
                "leakAvg": float(NUM_RE.search(r[8]).group(0)),
            }
        )
    aggregates = {
        k: {p: v for p, v in quart(find_row(tables, LABELS[k])).items() if p != "avg"}
        for k in ("tv", "bpm", "ie", "mv")
    }
    return nights, aggregates


def main() -> None:
    dirp = Path(sys.argv[1]).expanduser()
    daily_t = doc_tables(dirp / "Daily Report.docx")
    stat_t = doc_tables(dirp / "Statistical Report.docx")
    if "--dump" in sys.argv:
        dump(daily_t, "Daily Report")
        dump(stat_t, "Statistical Report")
        return
    daily = parse_daily(daily_t)
    nights, aggregates = parse_statistical(stat_t)
    out = {"daily": daily, "nights": nights, "aggregates": aggregates}
    for path, want in SELFCHECK.items():
        got = out
        for k in path:
            got = got[k]
        if abs(float(got) - float(want)) > 1e-9:
            raise SystemExit(f"selfcheck failed: {path} = {got}, expected {want}")
    (dirp / "expected.json").write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {dirp / 'expected.json'} ({len(nights)} nights)")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run it against the real reports**

Run: `python3 tools/reports-to-json.py ~/Downloads/dreamsleep --dump` first, compare the printed tables against the `LABELS` patterns and the assumed column orders (press row, quartet order Avg/95/90/50, statistical column order), fix the patterns/index mapping to match the actual document, then run without `--dump` until the SELFCHECK passes. The SELFCHECK values are ground truth from the spec — never edit them to make extraction pass. If the reports are unavailable on this machine, stop and report; Tasks 6–7 need them.

- [ ] **Step 3: Write `src/test/reports.test.ts`**

```ts
// Opt-in oracle: breath-derived metrics vs the vendor's own saved reports.
//   make test-reports DS1_DIR=~/Downloads/dreamsleep
// Requires expected.json in DS1_DIR (tools/reports-to-json.py). Never in CI.
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildNight } from '../parse/metrics'
import { parseDs1 } from '../parse/ds1'
import type { BreathMetrics } from '../types'

type Quart = { avg: number; p50: number; p90: number; p95: number }
type Expected = {
  daily: {
    date: string
    tv: Quart
    bpm: Quart
    leak: Quart
    ie: Omit<Quart, 'avg'>
  }
  nights: Array<{ date: string; p90: number; p95: number }>
  aggregates: {
    tv: Omit<Quart, 'avg'>
    bpm: Omit<Quart, 'avg'>
    ie: Omit<Quart, 'avg'>
    mv: Omit<Quart, 'avg'>
  }
}

const dir = process.env['DS1_DIR']?.replace(/^~/, process.env['HOME'] ?? '')
const d = dir ? describe : describe.skip

d('breath metrics vs vendor reports', () => {
  if (!dir) return
  const dataDir = resolve(dir)
  const expected = JSON.parse(
    readFileSync(join(dataDir, 'expected.json'), 'utf8')
  ) as Expected

  const byDate = new Map<string, BreathMetrics>()
  for (const f of readdirSync(dataDir).filter((f) => f.endsWith('.ds1'))) {
    const buf = readFileSync(join(dataDir, f))
    const { sessions, partial } = parseDs1(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      f
    )
    const stem = f.replace(/\.ds1$/, '')
    const night = buildNight(stem, sessions, partial)
    if (!night.breath) continue
    const dt = night.date
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    byDate.set(key, night.breath)
  }

  const daily = () => {
    const b = byDate.get(expected.daily.date)
    if (!b) throw new Error(`daily night ${expected.daily.date} not decoded`)
    return b
  }
  const d10 = (x: number) => Math.round(x * 10)

  test('assertion 1: expiratory P90/P95 exact, every night', () => {
    let checked = 0
    for (const row of expected.nights) {
      const b = byDate.get(row.date)
      expect(b, `night ${row.date} missing`).toBeDefined()
      if (!b) continue
      expect(b.expPress.p90, `${row.date} P90`).toBe(d10(row.p90))
      expect(b.expPress.p95, `${row.date} P95`).toBe(d10(row.p95))
      checked++
    }
    expect(checked).toBe(expected.nights.length)
  })

  test('assertion 2: TV exact, daily night', () => {
    const b = daily()
    const e = expected.daily.tv
    expect(b.tv.avg).toBe(e.avg)
    expect(b.tv.p50).toBe(e.p50)
    expect(b.tv.p90).toBe(e.p90)
    expect(b.tv.p95).toBe(e.p95)
  })

  test('assertion 3: BPM exact, daily night', () => {
    const b = daily()
    const e = expected.daily.bpm
    expect(d10(b.bpm.avg)).toBe(d10(e.avg))
    expect(d10(b.bpm.p50)).toBe(d10(e.p50))
    expect(d10(b.bpm.p90)).toBe(d10(e.p90))
    expect(d10(b.bpm.p95)).toBe(d10(e.p95))
  })

  test('assertion 4: leak within 0.2 L/min, daily night', () => {
    const b = daily()
    const e = expected.daily.leak
    for (const [ours, theirs] of [
      [b.leak.avg, e.avg],
      [b.leak.p50, e.p50],
      [b.leak.p90, e.p90],
      [b.leak.p95, e.p95],
    ] as const)
      expect(Math.abs(ours - theirs)).toBeLessThanOrEqual(0.2)
  })

  const meanOf = (f: (b: BreathMetrics) => number) => {
    const vs = [...byDate.values()].map(f)
    return vs.reduce((a, x) => a + x, 0) / vs.length
  }
  const closeTo = (ours: number, theirs: number, label: string) =>
    expect(Math.abs(ours - theirs), label).toBeLessThanOrEqual(0.05)

  test('assertion 5: 13-night mean of TV and BPM at 50/90/95', () => {
    for (const p of ['p50', 'p90', 'p95'] as const) {
      closeTo(
        meanOf((b) => b.tv[p]),
        expected.aggregates.tv[p],
        `tv ${p}`
      )
      closeTo(
        meanOf((b) => b.bpm[p]),
        expected.aggregates.bpm[p],
        `bpm ${p}`
      )
    }
  })

  test('assertion 6: 13-night mean of I:E at 50/90/95', () => {
    for (const p of ['p50', 'p90', 'p95'] as const)
      closeTo(
        meanOf((b) => b.ie[p]),
        expected.aggregates.ie[p],
        `ie ${p}`
      )
  })

  test('assertion 7: 13-night mean of minute volume at 50/90/95', () => {
    for (const p of ['p50', 'p90', 'p95'] as const)
      closeTo(
        meanOf((b) => b.mv[p]),
        expected.aggregates.mv[p],
        `mv ${p}`
      )
  })
})
```

- [ ] **Step 4: Add the Makefile target** (after `test-diff`, and add `test-reports` to `.PHONY`):

```make
test-reports: ## Breath-metric oracle vs vendor reports: make test-reports DS1_DIR=~/Downloads/dreamsleep
	DS1_DIR=$(DS1_DIR) pnpm vitest run src/test/reports.test.ts
```

- [ ] **Step 5: Verify plumbing**

Run: `pnpm vitest run src/test/reports.test.ts` (no `DS1_DIR`)
Expected: suite skips cleanly. Then `pnpm typecheck && pnpm lint`.

- [ ] **Step 6: Checkpoint / commit (only if authorized)**

Suggested message: `test: vendor-report oracle extraction tool and opt-in assertions`

Note: `expected.json` stays in `$DS1_DIR`, outside the repo; only the tool and the test are committed.

---

### Task 7: Oracle reconciliation (requires real data)

**Files:** none new — this task runs the oracle and, on failure, iterates on `src/parse/breath.ts`/`metrics.ts` under the spec's debugging rules.

- [ ] **Step 1: Run the gate**

Run: `make test-reports DS1_DIR=~/Downloads/dreamsleep`
Assertion 1 (P90/P95, 13 nights, exact) is the gate. **Do not debug assertions 2–7 until assertion 1 passes.**

- [ ] **Step 2: If assertion 1 fails, work the spec's hypothesis ladder in order — never loosen a tolerance instead:**

1. **Session gaps** (the spec's first hypothesis, stated as the mandatory first test): change the concatenation in `buildNight` to zero-fill the wall-clock gap between session `end` and the next session `start` (`gapSamples = round((next.start − prev.end)/1000 × 10)` zeros in both channels) and re-run. The vendor's `zeroRun` compensation in `segmentBreaths` already handles the blanks. If this fixes the oracle, keep zero-filling (it is the more faithful port) and update the spec's Deviations section to record that the contiguous shortcut failed.
2. **float32 vs float64:** audit every stored value in `breath.ts` and `lowpassF32` for a missing `Math.fround`/f32 store.
3. **half-to-even vs half-up:** grep `src/parse/breath.ts` and `signal.ts` for `Math.round` — there must be none.
4. A **structural miss** (breath counts off by >1%) means the threshold or crossing rule was misread — stop and compare `night.breaths.count` per night against `duration × bpm.avg` from the reports before changing anything.

- [ ] **Step 3: Assertions 2–7.** TV off by a constant factor across all nights is the `FLOW_LPM` correction, not a segmentation bug (spec, "What changed" #2) — surface it to the user before changing the constant, since `FLOW_LPM` also feeds the existing leak/flow displays. Leak outside ±0.2 across all nights is likewise a scale question; per the spec, leak then ships without the vendor-comparison claim.

- [ ] **Step 4: Record the outcome in the spec.** Whatever passes/fails, append a dated "Validation outcome" note to `docs/superpowers/specs/2026-08-14-breath-metrics-v1-design.md` listing which assertions passed at which tolerance and any deviation taken (e.g. gap zero-filling). This is the spec's own requirement for any loosened tolerance.

- [ ] **Step 5: Re-run everything**

Run: `make test && make test-diff DS1_DIR=~/Downloads/dreamsleep && make test-reports DS1_DIR=~/Downloads/dreamsleep`
Expected: all green.

- [ ] **Step 6: Checkpoint / commit (only if authorized)**

Suggested message: `fix: reconcile breath port against vendor report oracle` (only if changes were needed).

---

### Task 8: UI — estimated labelling, Summary, NightDetail, Histogram caveat

**Files:**

- Create: `src/ui/Estimated.tsx`
- Modify: `src/app.css` (`.estimated` rule, near the `.info-tip` block at line ~164)
- Modify: `src/state.ts:102-122` (`kpis`)
- Modify: `src/state.test.ts` (kpis coverage)
- Modify: `src/ui/Summary.tsx`
- Modify: `src/ui/NightDetail.tsx` (add `BreathStats`, render after `<Histogram/>`)
- Modify: `src/ui/Histogram.tsx:30` (tooltip text — **only if oracle assertion 1 passed in Task 7**)

**Interfaces:**

- Consumes: `Night.breath` (Task 5); `kpis` gains `avgHp90: number | null` and `avgHp95: number | null` (null when no visible night has breath metrics).

- [ ] **Step 1: Write the failing kpis test** (append to `src/state.test.ts`; extend the local `night()` helper with an optional breath argument or build one inline):

```ts
test('kpis averages breath-derived HP percentiles over nights that have them', () => {
  const hp = (p90: number, p95: number): Night['breath'] =>
    ({
      breaths: 1000,
      expPress: { avg: 60, min: 41, p90, p95 },
      inspPress: { avg: 65, max: 85, p90: 70, p95: 72 },
      tv: { avg: 199, p50: 196, p90: 249, p95: 289 },
      bpm: { avg: 15.1, p50: 15, p90: 18.1, p95: 19.3 },
      ie: { avg: 1.2, p50: 1.2, p90: 1.5, p95: 1.7 },
      mv: { avg: 3000, p50: 2950, p90: 4500, p95: 5600 },
      leak: { avg: 14.8, p50: 14.7, p90: 17.4, p95: 18.2 },
    }) as Night['breath']
  const a = { ...night('01082026', 2026, 8, 1), breath: hp(60, 66) }
  const b = { ...night('02082026', 2026, 8, 2), breath: hp(66, 72) }
  const c = night('03082026', 2026, 8, 3) // breath: null
  const k = kpis([a, b, c])
  expect(k.avgHp90).toBeCloseTo(6.3, 9) // mean of 6.0 and 6.6 cmH2O
  expect(k.avgHp95).toBeCloseTo(6.9, 9)
  expect(kpis([c]).avgHp95).toBeNull()
})
```

- [ ] **Step 2: Run it to verify it fails** — `pnpm vitest run src/state.test.ts` (fails: `avgHp90` undefined; typecheck fails first, which counts).

- [ ] **Step 3: Implement `kpis`** — extend the return type with `avgHp90: number | null; avgHp95: number | null` and:

```ts
const withBreath = nights.filter((n) => n.breath !== null)
const avgB = (f: (b: BreathMetrics) => Deci) =>
  withBreath.length
    ? withBreath.reduce((a, n) => a + cmH2O(f(n.breath!)), 0) /
      withBreath.length
    : null
```

with `avgHp90: avgB((b) => b.expPress.p90), avgHp95: avgB((b) => b.expPress.p95)` in the result (`import type { BreathMetrics, Deci }` added; `cmH2O` is already imported).

- [ ] **Step 4: Create `src/ui/Estimated.tsx`**

```tsx
import type { ComponentChildren } from 'preact'

const TIP =
  'Estimated: reconstructed from the flow waveform by this viewer, not ' +
  'read from a decoded field.'

export function Estimated({ children }: { children: ComponentChildren }) {
  return (
    <span class="estimated" data-tooltip={TIP} data-placement="bottom">
      {children}
    </span>
  )
}
```

Add to `src/app.css` next to the `.info-tip` block:

```css
/* Breath-derived estimates: visually distinct from channel-exact values */
.estimated {
  border-bottom: 1px dotted currentColor;
  cursor: help;
}
```

- [ ] **Step 5: Rework `Summary.tsx`.** Replace the `avg P95` cell: when `k.avgHp95 !== null`, render a cell whose `<h4>` content is wrapped in `<Estimated>`:

```tsx
const HP_TIP =
  'Horizontal Pressure P90/P95, matching the vendor report: percentiles ' +
  'of pressure during the later part of each exhalation, reconstructed ' +
  'from the flow channel. Channel-exact sample-stream avg P95: ' +
  `${k.avgP95.toFixed(1)} cmH2O.`
```

```tsx
{
  k.avgHp90 !== null && k.avgHp95 !== null ? (
    <div style="text-align:center">
      <h4 style="margin-bottom:0">
        <Estimated>
          {k.avgHp90.toFixed(1)} / {k.avgHp95.toFixed(1)}
        </Estimated>
      </h4>
      <small>
        HP P90/P95{' '}
        <span class="info-tip" data-tooltip={HP_TIP} data-placement="bottom">
          ⓘ
        </span>
      </small>
    </div>
  ) : (
    kpi('avg P95', `${k.avgP95.toFixed(1)} cmH2O`)
  )
}
```

The other four KPI cells are unchanged; `NightTable` and `TrendChart` are unchanged (spec).

- [ ] **Step 6: Add `BreathStats` to `NightDetail.tsx`** and render `<BreathStats night={night} />` after `<Histogram night={night} />`:

```tsx
function BreathStats({ night }: { night: Night }) {
  const b = night.breath
  if (!b) return null
  const f1 = (n: number) => n.toFixed(1)
  const rows: Array<[string, string, string, string, string]> = [
    [
      'Tidal Volume (mL)',
      `${b.tv.avg}`,
      `${b.tv.p50}`,
      `${b.tv.p90}`,
      `${b.tv.p95}`,
    ],
    [
      'Breath Rate (BPM)',
      f1(b.bpm.avg),
      f1(b.bpm.p50),
      f1(b.bpm.p90),
      f1(b.bpm.p95),
    ],
    [
      'I:E',
      `1:${f1(b.ie.avg)}`,
      `1:${f1(b.ie.p50)}`,
      `1:${f1(b.ie.p90)}`,
      `1:${f1(b.ie.p95)}`,
    ],
    [
      'Minute Vent. (mL/min)',
      `${b.mv.avg}`,
      `${b.mv.p50}`,
      `${b.mv.p90}`,
      `${b.mv.p95}`,
    ],
    [
      'Leakage (L/min)',
      f1(b.leak.avg),
      f1(b.leak.p50),
      f1(b.leak.p90),
      f1(b.leak.p95),
    ],
  ]
  return (
    <div>
      <div class="u-title">
        breath metrics <Estimated>estimated</Estimated>
      </div>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Avg</th>
            <th>50%</th>
            <th>90%</th>
            <th>95%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, ...vals]) => (
            <tr key={label}>
              <td>{label}</td>
              {vals.map((v, i) => (
                <td key={i}>
                  <Estimated>{v}</Estimated>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

(Import `Estimated` in both `Summary.tsx` and `NightDetail.tsx`.)

- [ ] **Step 7: Histogram caveat — conditional.** Only if Task 7's assertion 1 passed, replace the tooltip at `src/ui/Histogram.tsx:30` with:

```
Time-weighted percentiles of the raw pressure samples (channel-exact). The Horizontal Pressure P90/P95 in the summary reproduce the vendor's breath-based figures.
```

If assertion 1 did not pass, leave the existing caveat text exactly as is (spec: "removed once assertion 1 passes — and not before").

- [ ] **Step 8: Verify**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint && make build`
Expected: green; bundle under 800 KB. Then eyeball it: `make dev`, drop a real `.ds1`, check the Summary HP cell, the NightDetail table, the dotted-underline tooltips, and the null path (a sub-10-minute file shows no breath table and the fallback avg P95 KPI).

- [ ] **Step 9: Checkpoint / commit (only if authorized)**

Suggested message: `feat: surface breath-derived metrics in Summary and NightDetail as estimates`

---

### Task 9: Definition of done

- [ ] **Step 1:** `make typecheck && make test && make lint && make build` — all green, bundle under 800 KB.
- [ ] **Step 2:** `make test-diff DS1_DIR=~/Downloads/dreamsleep` — still passes (frozen behaviour).
- [ ] **Step 3:** `make test-reports DS1_DIR=~/Downloads/dreamsleep` — assertions 1–7 at the spec's tolerances, or the spec documents exactly which were loosened and why (Task 7 Step 4).
- [ ] **Step 4:** Grep gates: `grep -rn "Math.round" src/parse/breath.ts src/parse/signal.ts` → only `roundHalfEven`'s internals may use `Math.floor`; no `Math.round`. `grep -rn ": any\b\|as any" src/` → nothing new.
- [ ] **Step 5:** Report results to the user with the actual command output; the user decides on merging/committing.
