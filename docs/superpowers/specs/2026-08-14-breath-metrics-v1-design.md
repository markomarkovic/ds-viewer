# Breath-derived metrics, v1 (deterministic reductions)

Design spec, 2026-08-14. Implements the deterministic half of
[`2026-08-14-breath-metrics-design.md`](2026-08-14-breath-metrics-design.md): breath
segmentation of the flow channel and the five metric families it unlocks — expiratory
P90/P95, tidal volume, respiratory rate, I:E, minute ventilation — plus per-breath leakage.

**Apnea/hypopnea re-scoring, the OSA/CSA split, AHI and waveform event marking are out of
scope.** They depend on the same breath list, which is why this spec retains it, but they
carry irreducible uncertainty that these metrics do not and get their own spec.

## What changed since the parent spec

The parent spec designed from a partial read of the IL and flagged the algorithm as
"under-specified". A full read of `CalIsnpExp`, `GetInspExpPress`, `GetFlowBlock`,
`LowPass_Float`, `CalPress` and `Percentile` in `DP.Analysis.AnalysisFileV2` closes that gap
and corrects three assumptions:

1. **P90/P95 are not per-breath `ExpMinPress` percentiles.** `GetInspExpPress` accumulates
   _individual pressure samples_ falling in the later two-thirds of each expiratory phase,
   filtered to `≥ 40` (4.0 cmH2O), and takes the percentile over that sample list. The
   per-breath `InsMaxPress`/`ExpMinPress` fields are computed but never feed the reported
   figures. The parent spec's bracketing experiment was measuring the right neighbourhood for
   the wrong reason.
2. **The flow scale is confirmed by construction, not just empirically.** `iTV` is
   `round(Σ|flow − baseline − 3| / 5)`. One count sustained for one 10 Hz sample at
   0.12 L/min is `0.12 × (0.1/60) L = 0.2 mL`, so `Σcounts × 0.2 mL` _is_ `Σcounts / 5`. The
   `/5` divisor and the 0.12 L/min/count constant are the same statement. If the reports' TV
   values reproduce, 0.12 is confirmed; if they are off by a constant factor, that factor is
   the correction to `FLOW_LPM`.
3. **Effective Duration is just recorded duration.** The 11/08 report prints
   `Duration 7:28:33` and `Effective Duration 7.48 Hours`; 7:28:33 is 7.4758 h. There is no
   mask-off exclusion to reverse-engineer — the parent spec's open question is closed, and
   the AHI denominator (for the follow-on) is the `Night.hours` we already compute.

Two further constants the parent spec did not have: the inspiration/expiration threshold is
`baseline + 3` counts, not the baseline; and every aggregate excludes the first and last
**5 minutes** (`MinuteData = 300 × HZ = 3000` samples) of the concatenated recording.

## The algorithm

Transcribed from the IL. Implementations should follow this section and need not re-read the
disassembly.

### Inputs

Let `flow` and `press` be the whole night's channels, sessions concatenated in order (see
_Deviations_), as `Float32Array`. Three smoothed derivatives, all via the vendor's
two-pass filter (our existing `lowpass`, forward then backward, `k = a/100`):

| Array         | Source  | α   | Used for                          |
| ------------- | ------- | --- | --------------------------------- |
| `flowSmooth`  | `flow`  | 50  | breath boundaries, TV, leak       |
| `flowBase`    | `flow`  | 3   | the baseline the boundaries cross |
| `pressSmooth` | `press` | 20  | the P90/P95 sample pool           |

`DataVer` is 1 for `.ds1` (the vendor derives it from the filename's last character), which
selects the `/5` TV divisor. The `/2` path is for an older device generation we do not read.

### Segmentation — port of `CalIsnpExp`

```
breaths = []
inInsp = false, armed = true
tvAcc = 0, zeroRun = 0

for n = 10 to flowSmooth.length - 3 inclusive:
    prevFlow = flowSmooth[n-1]      nextFlow = flowSmooth[n+1]
    prevThr  = flowBase[n-1] + 3    nextThr  = flowBase[n+1] + 3

    if flowSmooth[n] == 0: zeroRun++

    # rising crossing of the threshold -> inspiration starts
    if armed and (prevThr - prevFlow) > 0.1 and (nextFlow - nextThr) >= 0:
        inInsp = true; armed = false
        breaths.push({ iInsp: n, iLeak: prevFlow })
        k = breaths.length - 1                   # index of the breath just pushed
        if k > 0:
            prev = breaths[k-1]
            prev.iNextInsp = n - zeroRun
            prev.iBPM = 600 / (prev.iNextInsp - prev.iInsp)
            prev.iMV  = prev.iBPM * prev.iTV
            zeroRun = 0

    if inInsp: tvAcc += abs(roundHalfEven(prevFlow - prevThr))
    else:      tvAcc = 0

    # falling crossing -> expiration starts, closing the breath
    if inInsp and (prevFlow - prevThr) > 0.1 and (nextThr - nextFlow) > 0:
        inInsp = false; armed = true
        cur = breaths[breaths.length - 1]
        cur.iExp = n
        cur.iTV  = roundHalfEven(tvAcc / 5)      # DataVer == 1
```

Then the small-breath merge, also from `CalIsnpExp`:

```
small = [i for i in 2 .. breaths.length-1 if breaths[i].iTV <= 20]
for i in reversed(small):
    if i + 1 >= breaths.length - 1: continue     # length is re-read each pass
    breaths[i-1].iNextInsp = breaths[i+1].iInsp
    remove breaths[i]
```

Details that matter for reproducing the vendor's numbers:

- `Math.Round` in .NET is **round-half-to-even**, not half-away-from-zero. Both TV roundings
  use it. `Math.round` in JS is half-up and will drift.
- The vendor arithmetic is `float32` throughout. Accumulating in `float64` and rounding at
  the end gives different `iTV` values on ties. Use `Math.fround` at each assignment, or
  `Float32Array` scratch, wherever a value is stored back.
- The merge does **not** recompute `iBPM`/`iMV` for the breath whose `iNextInsp` it rewrites,
  so those fields stay stale. This is a vendor bug; reproduce it. Deviating here makes BPM
  disagree with the reports.
- `zeroRun` counts samples where the _smoothed_ flow is exactly `0`, which only happens in
  the vendor's zero-filled inter-session blank blocks. See _Deviations_.
- The merge starts at index 2, so the first two breaths are never removed.
- The vendor's `List<TBreath>.Remove(value)` does a field-wise equality search; because
  `iInsp` is unique per breath it is equivalent to removing at index `i`.
- **The final breath is never finalized.** `iNextInsp`, `iBPM` and `iMV` are only written
  when the _next_ inspiration opens, so the last breath in the list keeps the struct's zero
  defaults — as does any breath left open when the recording ends mid-inspiration, which also
  has `iExp = 0` and `iTV = 0`. `reduceBreaths` still processes it: `end = min(0, length)` is
  0, so the sample scan body never runs, but the breath contributes `0` to `bpmL` and `mvL`
  and a negative value to `ieL`. Reproduce this rather than filtering it out. It is one
  element in roughly forty thousand and cannot move a percentile, but leaving it unspecified
  invites two implementations that disagree on the mean.

### Reduction — port of `GetInspExpPress`

`MinuteData = 3000`. All seven lists are `float32`.

```
inspSamples = expSamples = tvL = leakL = bpmL = mvL = ieL = []

for b in breaths:
    if b.iInsp < MinuteData: continue

    # the appends precede the break test, so the breath that ends the loop
    # still contributes to every list except the two pressure pools
    tvL   += b.iTV
    leakL += b.iLeak
    bpmL  += b.iBPM * 10
    mvL   += b.iBPM * b.iTV
    ieL   += (b.iNextInsp - b.iExp) / (b.iExp - b.iInsp) * 10

    end = min(b.iNextInsp, pressSmooth.length)
    inspFrom = b.iInsp + (b.iExp - b.iInsp) / 3        # integer division
    expFrom  = b.iExp  + (b.iNextInsp - b.iExp) / 3
    if end > pressSmooth.length - MinuteData: break

    for i in b.iInsp .. end-1:
        p = trunc(pressSmooth[i])
        b.InsMaxPress = max(b.InsMaxPress, p)          # init 0
        b.ExpMinPress = min(b.ExpMinPress, p)          # init 300
        if i > inspFrom and i < b.iExp:                       inspSamples += pressSmooth[i]
        if i > expFrom  and i < end and pressSmooth[i] >= 40:  expSamples  += pressSmooth[i]

if inspSamples empty or expSamples empty: return no metrics
```

The reported **Horizontal Pressure P90/P95 are `percentile(expSamples, 90/95)`.**
**[Superseded — see Validation outcome, item 1.]**

`percentile(list, p)` is the vendor's helper: sort ascending, take element
`⌊length × p / 100⌋`, truncate to int. Note the index is _not_ clamped — for `p = 100` it
would throw; we only call it with 50/90/95.

Aggregate fields, with the vendor's scale factor and rounding:

| Field                            | Source list   | Vendor value                | Display            |
| -------------------------------- | ------------- | --------------------------- | ------------------ |
| `ExpPresP90` / `P95`             | `expSamples`  | `percentile(·, 90/95)`      | ÷10 → cmH2O        |
| `ExpPresAvg`                     | `expSamples`  | `trunc(mean)`               | ÷10                |
| `ExpPresMin`                     | `expSamples`  | `max(trunc(min), PressMin)` | ÷10                |
| `InspPresP90` / `P95`            | `inspSamples` | `percentile(·, 90/95)`      | ÷10                |
| `InspPresAvg`                    | `inspSamples` | `trunc(mean)`               | ÷10                |
| `InspPresMax`                    | `inspSamples` | `min(trunc(max), PressMax)` | ÷10                |
| `TV_P50/90/95`, `TV_Avg`         | `tvL`         | percentile / `trunc(mean)`  | mL as-is           |
| `BPM_P50/90/95`, `BPM_Avg`       | `bpmL`        | percentile / `trunc(mean)`  | ÷10                |
| `IE_P50/90/95`, `IE_Avg`         | `ieL`         | percentile / `trunc(mean)`  | ÷10 → the x in 1:x |
| `MVV_P50/90/95`, `MVV_Avg`       | `mvL`         | percentile / `trunc(mean)`  | mL/min as-is       |
| `LeakageP50/90/95`, `LeakageAvg` | `leakL`       | percentile / `trunc(mean)`  | see _Deviations_   |

There is no `P50` for either pressure series and no pressure percentile other than 90/95.
The `Avg` fields are `(int)Math.Round(mean, 2)`, which for these magnitudes is truncation of
the mean; the `Max` fields are `(int)Math.Round(max, 1)`.
**[Superseded — see Validation outcome, item 3.]**

`PressMin`/`PressMax` come from the vendor's `CalPress` over the same `pressSmooth` array
with values clamped into `[40, 300]` and the first/last `MinuteData` samples excluded.
`CalPress` does not mutate the pressure array.
**[Superseded — see Validation outcome, item 1.]**

**Truncation is load-bearing.** The vendor truncates to int at a fixed ×1 or ×10 scale, and
the reports print what it truncated. `bpm.p95` must be `trunc(f32(bpm_k × 10)) / 10`, not
`round(bpm_k, 1)`. Applying the truncation at the vendor's point in the pipeline is the
difference between reproducing 19.3 and reproducing 19.3-ish.

## Module structure

Three files in `src/parse/`, all DOM-free and worker-agnostic like the rest of the directory.

**`src/parse/signal.ts`** (new). `lowpass`, `lowpassF32`, `median` (moved from `metrics.ts`)
and `percentileVendor(sorted, p)`. This file exists only so `metrics.ts` and `breath.ts` can
share the filter without importing each other; no behaviour changes and `metrics.test.ts`
updates its import path. `lowpassF32` is the `Float32Array` variant needed for bit-fidelity
with the vendor; `lowpass` keeps its current `Float64Array` signature and its current
callers.

**`src/parse/breath.ts`** (new). Two pure functions:

```ts
export function segmentBreaths(
  flowSmooth: Float32Array,
  flowBase: Float32Array
): BreathTable

export function reduceBreaths(
  table: BreathTable,
  pressSmooth: Float32Array
): BreathMetrics | null
```

**`src/parse/metrics.ts`**. `buildNight` gains a stage: concatenate the sessions' `press` and
`flow` into `Float32Array`s, derive the three smoothed arrays, call the two functions above,
attach both results to the `Night`.

### Types

```ts
export type Ml = Brand<number, 'Ml'> // millilitres; new brand
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

`Ml` gets its mutual-unassignability assertion in `types.brands.ts` alongside the others.

`Night` gains two nullable fields:

```ts
breath: BreathMetrics | null // null when the trim leaves no breaths
breaths: BreathTable | null // retained for the event-scoring follow-on
```

Both are null for recordings under ~10 minutes, which the head and tail trims empty out. Every
consumer must handle null; the shortest night in the corpus (13/08, 1:47) is comfortably long
enough that null is an edge case, not the common path.

`BreathTable`'s six typed arrays are transferred from the worker alongside the existing
`press`/`flow`/`leak` buffers — roughly 1 MB for a full night, at no copy cost. It is retained
rather than recomputed because the event-scoring follow-on reduces over exactly this list;
v1 itself does not read it after `reduceBreaths`.

## Deviations from the vendor, both testable

**Session gaps — the contiguous shortcut failed reconciliation and was replaced.** The
vendor segments one array spanning every block, including zero-filled blank blocks covering
the wall-clock gaps between sessions (`InitBlankBlock`: `10 × wholeSeconds(next.start −
prev.end)` zeros, reversed timestamps swapped, i.e. `abs`). This spec originally shipped a
contiguous concatenation; the oracle rejected it, and `buildNight` now reproduces the
vendor's assembly exactly: **each session is smoothed on its own** (the vendor filters per
block, so blank regions stay exactly zero and nothing bleeds across seams) and the smoothed
sessions are placed at their wall-clock offsets on a zero-filled timeline. The zeroRun
compensation in `segmentBreaths` is unchanged and now operates on real zeros.

**Leak scale — resolved.** The vendor prints `Leakage*` fields (raw smoothed-flow counts
from `GetInspExpPress`) divided by **10**, not multiplied by `FLOW_LPM` (its `SetMaskState`
divides `iLeak` by 10 the same way). `reduceBreaths` therefore reports `counts / 10` as
L/min for the breath-leak quartet, and the 11/08 oracle quartet (14.8, 14.7/17.4/18.2)
reproduces to the displayed digit. `FLOW_LPM = 0.12` is untouched and still feeds the
existing leak/flow displays (`Session.leak`, `leakMedian`), whose physical calibration is a
separate question from what the vendor's report prints.

## Validation

Real recordings and the values derived from them stay out of the repo, per the existing
policy behind `make test-diff`.

- **`tools/reports-to-json.py`** (committed) unzips `Daily Report.docx` and
  `Statistical Report.docx` from a given directory, parses `word/document.xml`, and writes
  `expected.json` into `$DS1_DIR`. Deterministic, no network, no waveform data.
- **`src/test/reports.test.ts`** (committed) is opt-in on `DS1_DIR`, mirroring
  `differential.test.ts`, and skips entirely when it is unset. Run via `make test-reports`.
- **`src/parse/breath.test.ts`** (committed) is the CI-visible guard: synthetic flow signals
  — square and sinusoidal, at known rates, amplitudes and duty cycles — where breath count,
  TV, BPM and I:E are known analytically. It also covers the boundary rules directly: the
  `iTV ≤ 20` merge, the stale-BPM behaviour after a merge, the 5-minute trims, and the
  empty-result path. These tests are what actually protect the port; the oracle test proves
  it once.

Oracle assertions, in the order the plan should land them:

| #   | Assertion                                        | Source                   | Tolerance            |
| --- | ------------------------------------------------ | ------------------------ | -------------------- |
| 1   | P90 and P95 per night, 13 nights                 | Statistical report table | exact (integer deci) |
| 2   | TV avg + 50/90/95, 11/08                         | Daily report             | exact                |
| 3   | BPM avg + 50/90/95, 11/08                        | Daily report             | exact                |
| 4   | Leak avg + 50/90/95, 11/08                       | Daily report             | ±0.2 L/min           |
| 5   | Mean over 13 nights of TV and BPM at 50/90/95    | Statistical report       | ±0.05                |
| 6   | Mean over 13 nights of I:E at 50/90/95           | Statistical report       | ±0.05                |
| 7   | Mean over 13 nights of minute volume at 50/90/95 | Statistical report       | ±0.05                |

Assertion 1 is the gate: it exercises segmentation, the threshold, the merge, the trim, the
expiratory window and the percentile helper simultaneously, across 13 independent nights. If
it passes, the port is right. Nothing downstream should be debugged until it does.

Start every assertion at the strictest tolerance the table allows. Loosening one requires a
stated reason recorded in the spec, not a passing test.

## UI

Breath-derived figures are estimates from a heuristic port and must read as visually distinct
from the channel-exact metrics — the constraint carried over from the original viewer spec.

- One shared `<Estimated>` wrapper marks every breath-derived value, with a tooltip naming it
  a reconstruction from the flow channel rather than a decoded field. Every number introduced
  by this spec is wrapped.
- `Summary` promotes the breath-derived pair to primary, labelled **Horizontal Pressure
  P90/P95** to match the vendor's own wording. The existing sample-stream percentiles move to
  the tooltip, described as the channel-exact sample distribution. The current "does not match
  the vendor's report" caveat is removed once assertion 1 passes — and not before.
- `NightDetail` gains TV, BPM, I:E, minute ventilation and leakage rows, each showing
  avg and 50/90/95 in the reports' own layout.
- `NightTable` and `TrendChart` are unchanged in v1. Trending breath metrics across nights is
  a reasonable follow-up but adds no validation value.

Not changed: `press.avg`, `press.median`, `press.max` keep their current per-session
derivation, which is validated sample-for-sample against `ds1.py`. `leakMedian` stays until
the leak scale is settled.

## Risks

- **Exact agreement across 13 nights is the goal, not a guarantee.** The segmenter is
  deterministic and fully transcribed, so the plausible failure modes are narrow: the gap
  concatenation, `float32` versus `float64` rounding, and half-to-even versus half-up. Each
  has a specific remedy above. What would be a genuine surprise is a _structural_ miss —
  breath counts off by more than a percent — which would mean the threshold or crossing rule
  was misread.
- **`Math.round` and `float64` accumulation are the two easy ways to silently miss.** Both
  produce plausible numbers that disagree with the reports in the last digit.
- **The oracle covers one corpus.** Thirteen nights from one device in one mode. It confirms
  the port, not its behaviour on hardware we have never seen.

## Validation outcome (2026-08-14)

Reconciliation was completed against the vendor's own assemblies (`DP.Analysis.dll` from
`DreamSleep 1.0.25EN.exe`, disassembled with monodis), because the hypothesis ladder in
_Risks_ was exhausted without closing the gap. Several claims in _The algorithm_ turned out
to be misread from the IL and are **superseded** by the implementation as follows:

1. **The reported Horizontal Pressure P90/P95 are not `percentile(expSamples, ·)`.** They
   are `CalPress`'s `PressP90/PressP95`: a 301-bin histogram of `trunc(pressSmooth[i])`
   clamped into `[40, 300]` over the **whole padded night including blank-block zeros**
   (which land in the 40 bin), where a percentile is the first bin whose cumulative
   permille, `(int)Math.Round(1000·cum/n)` (half-to-even), reaches 900/950. The
   `GetInspExpPress` pools exist in the vendor's code but do not feed the printed figures;
   `expPress.avg/min` and `inspPress.*` still come from them. `CalPress` also derives
   `PressMin`/`PressMax` over that same pass: `min` requires `v > 40` strictly and only
   scans the trim interior (excluding the head/tail `MINUTE_DATA` samples), initialized to
   100; `max` scans the whole array with no trim, then is capped at `p98 + 50`.
2. **The pressure channel is smoothed with the `List<float>` overload of `LowPass_Float`,
   which rounds every stored sample half-to-even to an integer** — the smoothed pressure is
   an integer sequence, and the histogram depends on it. Flow (α=50) and flow baseline
   (α=3) use the array overload (no per-step rounding). Both overloads compute
   `(prev·(100−F) + x·F)/100` with a single f32 rounding at the store, and smoothing is
   per block (per session), not across the concatenated night.
3. **The quartet `Avg` fields are not `(int)Math.Round(mean, 2)`.** They are
   `CalculatedValue(list, abn, 2)`: values `≥ abn` are replaced by 0 (still counted in the
   denominator), then f32-average, then `(int)` truncation, with `abn` = `TV_P98+200`,
   `BPM_P95+50`, `IE_P98+10`, `MVV_P98+1000`, `LeakageP98+100`. The pressure-pool averages
   are plain `(int)Average` with no `Round(·, 2)`.
4. **The vendor's file reader only processes whole 4096-byte chunks**; a trailing partial
   chunk is silently dropped (confirmed: it flips 07/08's P90, and the 13/08 snapshot
   duration 1:47:26 equals the chunk-truncated sample count exactly). The oracle test
   truncates its input accordingly. The viewer itself deliberately keeps the full file —
   dropping up to ~100 s of real tail data to mimic a read bug would make the app worse.
5. **The reports are a snapshot.** The corpus's `13082026.ds1` gained an evening session
   (and a 20-sample blip) after the reports were generated; the vendor's 13/08 rows
   describe only the morning session (1:47:26). The original download
   (`dreamsleep-20260813.zip`) preserves the file as reported; the oracle reads
   `DS1_DIR/report-snapshot/<file>.ds1.snapshot` in preference when present, and that
   directory now carries the snapshot `13082026.ds1.snapshot`. The `.snapshot` suffix is
   load-bearing: the viewer's dropzone recurses into subdirectories on a whole-folder
   drop and replaces nights by filename stem, so a plain `.ds1` copy in there would
   silently overwrite the real night with the stale one. All other 12 night files are
   byte-identical to the snapshot.

Per-assertion status at the original tolerances (nothing loosened):

| #   | Assertion                      | Tolerance  | Result                                     |
| --- | ------------------------------ | ---------- | ------------------------------------------ |
| 1   | P90/P95 per night, 13 nights   | exact      | **pass** (26/26 values)                    |
| 2   | TV avg + 50/90/95, 11/08       | exact      | **pass**                                   |
| 3   | BPM avg + 50/90/95, 11/08      | exact      | **pass**                                   |
| 4   | Leak avg + 50/90/95, 11/08     | ±0.2 L/min | **pass** (exact to the displayed digit)    |
| 5   | 13-night mean TV, BPM 50/90/95 | ±0.05      | **pass**                                   |
| 6   | 13-night mean I:E 50/90/95     | ±0.05      | **pass**                                   |
| 7   | 13-night mean MV 50/90/95      | ±0.05      | **fail**: p50 +0.215, p90 +0.323, p95 pass |

Assertion 7's residual is +3 (p50) and +4 (p90) mL/min summed over 13 nightly integers —
0.007 %/0.009 % relative — consistent with two or three breaths (out of ~80 000) sitting on
the other side of a pool boundary in one or two nights. Minute volume `fround(iBPM·iTV)` is
the only statistic whose values are near-unique per breath; every plateau-valued statistic
(TV, BPM, I:E, both pressure families) reconciles exactly, so the underlying breath lists
agree to within those few breaths. Exhausted without effect: gap arithmetic, chunk
truncation variants, post-OFF-marker sample handling, x87-vs-SSE float semantics, pool
membership rules re-derived from IL, and outlier-average semantics. The tolerance was NOT
loosened; `make test-reports` intentionally reports assertion 7 red until the cause is
found.

## Definition of done

- `make typecheck && make test && make lint && make build` green; the existing 50 tests still
  pass; `make test-diff DS1_DIR=~/Downloads/dreamsleep` still passes.
- `make test-reports DS1_DIR=~/Downloads/dreamsleep` passes assertions 1–7 at the tolerances
  in the table, or documents in this spec exactly which were loosened and why.
- No `any`, branded units throughout, Prettier clean.
- Bundle stays under the 800 KB budget.
