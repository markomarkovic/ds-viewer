# Respiratory event scoring and waveform marking

Design spec, 2026-08-14. Implements the second half of
[`2026-08-14-breath-metrics-design.md`](2026-08-14-breath-metrics-design.md): the vendor's
event re-scoring (obstructive and central apnea, hypopnea) over the breath list that
[v1](2026-08-14-breath-metrics-v1-design.md) already computes and retains, a
vendor-comparable AHI promoted throughout the UI, and the events drawn on the night page —
strip lanes for the overview, vendor-style labeled spans ("OSA: 12.7s") on the flow
waveform.

**Out of scope:** snore and flow-limitation scoring (`ET_SNORE`, `ET_FLAT`) — flow-shape
heuristics with no oracle in the saved artifacts and no effect on AHI.

## Decisions taken during brainstorming

1. **The re-scored AHI is promoted everywhere** — summary KPI, night-table column, trend
   chart — marked as estimated, with the device-flagged events still visible on the night
   page, labeled by provenance. When scoring is unavailable (`Night.breath` null) the UI
   falls back to the device-flag figure it shows today.
2. **`.EVT5` files are a test-only oracle.** The viewer always scores events itself from
   the flow channel; the vendor's persisted event files are consumed only by an opt-in
   differential test. The viewer stays self-contained.
3. **The scorer is a full transcription** of the vendor's `CalEvents`/`CalculationHI`/
   `GetAI`, the same method that made v1 exact. No black-box fitting.
4. **The validation gate is per-event equality** — type, start, duration — against the
   vendor's own `.EVT5` output across the full corpus, not count-level agreement.

## What changed since the first draft

A full IL read of `CalEvents`, `CalculationHI`, `GetAI`, `AddEventToFile` and the
`NewEventFile` serializer (every method read in full; nothing inferred from behavior
alone) overturned the parent spec's partial reading on four points:

1. **Apnea detection is not amplitude-reduction vs a running baseline.** It is a pure
   expiratory-pause test on the breath list: a pause (`iNextInsp − iExp`) between 9.6 s
   and 49.4 s with leak below 700 counts. No flow amplitude, no baseline, no percentage
   anywhere in the apnea path.
2. **The OSA/CSA split is not a breathing-effort persistence test.** It is a three-term
   tidal-volume-pattern test on neighbouring breaths plus a pause-length cap (< 15 s).
   The feared "effort proxy" — flagged as this feature's hardest risk — does not exist.
3. **Hypopnea is breath-relative TV reduction**, not reduction vs a running baseline, and
   the effective duration gate is **≥ 10.0 s** (integer division before the 9.5 compare),
   not "> 9.5 s" of real time.
4. **AHI confirmed: hypopneas are scored, saved, and ignored by the AHI.** `GetAI`'s type
   switch has no case for `0x17`; the printed figure is apneas only, per hour of
   non-zero-pressure time, truncated (not rounded) to one decimal. V2 never writes
   `mAHI`/`mHICount`.

The corpus also settles hypopnea coverage: 680 hypopnea events across the 69 `.EVT5`
files (1509 OSA, 853 CSA, 3042 total) — the differential test exercises the hypopnea
path hundreds of times; it does not lean on synthetic tests.

## Pipeline context

The vendor's `CalculationData(0)`, after the v1 stages (`CalPress`, `CalIsnpExp`,
`GetInspExpPress`), branches on the presence of an `.EVT5` beside the `.ds1`: if present
it **reads it back** instead of re-scoring (`FindEvents` keeps records with
`iValidation != 2`, then `CorrectEventPosition` converts ms → samples, exact since every
stored value is a multiple of 100 ms); otherwise it runs `CalEvents` →
`CalculationHI` → `AddEventToFile` (which writes the `.EVT5`, converting to ms in the
file only). The corpus `.EVT5`s were therefore produced by the scoring branch on first
open, over the vendor's chunk-truncated reads. In memory, events are always **samples on
the padded 10 Hz night timeline**.

One supplement to v1's segmentation: each breath's `blockId` is assigned at inspiration
open via `GetFlowBlock()` — iterate `BlockList` in order, accumulate `cum +=
FlowList.Count` for every block (blanks included), record `dict[block.ID] = cum` only for
real blocks (`ID != 9999`), and take the first real block whose exclusive end exceeds the
inspiration index. `blockId` feeds only the `.EVT5` record's `iBlockID`, never
type/start/length, and the viewer's scorer does not need it (the oracle test compares
type/start/duration).

## The algorithm

Transcribed from the IL. Implementations follow this section and need not re-read the
disassembly. `TBreath` fields as in v1 (`iInsp`, `iExp`, `iNextInsp`, `iTV`, `iBPM`,
`iLeak`); all comparisons on int32 except `iLeak` (float32).

### `CalEvents(brList)` — apnea scoring and the OSA/CSA split

```
EventList = new List<TEvent>()
for i = 2; i < brList.Count - 3; i++:                 # non-short-circuit &s in the IL
    b = brList[i]
    if (b.iNextInsp - b.iExp > 95)                    # pause strictly > 9.5 s
       & (b.iNextInsp - b.iExp < 495)                 # strictly < 49.5 s
       & (b.iLeak < 700.0f):                          # f32 compare; 700 counts
        ev = new TEvent()                             # zero-initialized
        if (brList[i-1].iTV > b.iTV)                  # TV falling into the pause
           & (brList[i+1].iTV < brList[i+2].iTV)      # TV rising out of it
           & (b.iNextInsp - b.iExp < 150):            # pause strictly < 15 s
            ev.iType = 0x16                           # ET_CSA
        else:
            ev.iType = 0x15                           # ET_OSA
        ev.iStart = b.iExp                            # samples, padded timeline
        ev.iLen   = (uint16)(brList[i+1].iInsp - ev.iStart)
        EventList.Add(ev)
CalculationHI(brList)
```

Details that matter:

- **The gate and the length use different quantities.** The pause gate uses `iNextInsp`
  (v1: written as `n − zeroRun`, blank-block zeros subtracted, and rewritten by the
  small-breath merge), while `iLen` uses the raw index of the next surviving breath's
  inspiration. When the pause abuts an inter-session gap the gate can pass on ≤ 49.4 s of
  real pause while `iLen` spans the whole gap — the corpus contains a ~51-minute "OSA"
  this way. Vendor quirk; reproduce as-is.
- `iLen` passes through `conv.u2` (uint16); the port implements the wrap (`& 0xffff`).
  Values above 65 535 samples are unexercised in the corpus (max 30 705).
- Loop bounds `[2, Count−4]`: the first two and last three breaths can never start an
  apnea. The unfinalized final breath (v1) has `iNextInsp = 0`, so its pause is negative
  and cannot score.
- The `&`s are bitwise on bools — all operands evaluate; no observable difference in a
  port, but the operand order above is the IL order.

### `CalculationHI(brList)` — hypopnea scoring

All ratios are float64 computed from int32 TVs: `pct(a, b) = (a − b) * 1.0 / a * 100`
(operand order verbatim; division by the earlier breath `a`). NaN/±Inf from zero TVs fail
every band test below (the IL uses unordered branches); JS float64 semantics match
exactly.

```
n3 = brList.Count - 3
for k = 2; k < n3; k++:
    r1 = pct(brList[k-1].iTV, brList[k].iTV)
    r2 = pct(brList[k-2].iTV, brList[k].iTV)
    if not (r1 > 30 && r1 < 70 && r2 > 30 && r2 < 70): continue   # open interval (30,70)
    ev = new TEvent()
    ev.iStart = brList[k].iInsp
    for j = k; j < n3; j++:
        r3 = pct(brList[j+1].iTV, brList[j].iTV)      # recovery: j+1 is 30-70% above j
        if r3 > 30 && r3 < 70:                        # open interval
            len16 = (uint16)(brList[j].iExp - ev.iStart)
            if (len16 / 10) > 9.5:                    # C# int division, then float compare:
                                                      # effectively len16 >= 100 samples
                ev.iLen  = len16                      # samples
                ev.iType = 0x17                       # ET_HI
                EventList.Add(ev)                     # appended AFTER all apneas
                k = j                                 # outer resumes at j+1
            break                                     # inner ends either way
        r4 = pct(brList[k-1].iTV, brList[j].iTV)      # persistence vs pre-event breath k-1
        if r4 < 30 || r4 > 70: break                  # closed band [30,70] continues
        if r3 > 70: break                             # recovery overshoot aborts the scan
                                                      # (IL_01ea: ldloc r3; ldc.r8 70; cgt)
        if ((brList[j].iInsp - ev.iStart)) / 10 > 25: break   # int division (int64 in IL);
                                                      # stop scanning >= 26.0 s after start
```

- The event start is the **inspiration onset of the first reduced breath k**; the end is
  the **expiration onset of the last reduced breath j** (the breath before recovery).
- The duration gate is `trunc(len/10) > 9.5`, i.e. `len ≥ 100` samples — a 9.9 s
  reduction does not score; 10.0 s does. (Corpus minimum hypopnea length: exactly
  10 000 ms.)
- The 25 s check gates only _continuation_; the stored length is uncapped — a recovery
  breath stretched across a session gap produced a ~6-minute hypopnea in the corpus.
  Vendor quirk; reproduce.
- The persistence band is **closed** (`[30, 70]`), while the entry and recovery bands are
  **open** (`(30, 70)`). Boundary semantics matter for the synthetic tests.
- **Recovery overshoot aborts the scan** (correction, 2026-08-14): when `r3 > 70` — the
  next breath's TV jumps so far that the recovery ratio overshoots the open band — the
  inner loop breaks without scoring and the outer loop moves on from `k`; the vendor
  never resumes the scan past an overshoot to find a later in-band recovery. The first
  transcription of this section omitted the `if r3 > 70: break` line (IL_01ea sits
  between the persistence check and the 25 s check); the omission produced
  hypopnea-only over-counts on 40 of 69 corpus nights and no other deviation. NaN `r3`
  (zero TVs) does not trigger the abort (`cgt` is an ordered compare), same as every
  other band test here.
- On a scored event the outer loop jumps to `k = j + 1`, so hypopneas never overlap each
  other; they can overlap apneas (the two scans are independent).

### `GetAI()` — counts and the AHI arithmetic

Runs over `EventList` (samples) and the padded smoothed pressure. All counters reset to
0 first.

```
for e in EventList:
    switch e.iType:
        0x15: mOSACount++;  mSumMinOSA += e.iLen; mMaxSecOSA = max(mMaxSecOSA, e.iLen)
        0x16: mCSACount++;  mSumMinOSA += e.iLen; mMaxSecOSA = max(mMaxSecOSA, e.iLen)
        0x17: nothing                              # hypopneas are NOT counted
        (snore/flat/ODI cases exist; V2 scores none)

if mDuration > 0:                                  # DrawPressList.Length as f64
    valid = count of DrawPressList samples != 0    # blank blocks and mask-off drop out
    if valid > 60 * HZ * 20:                       # > 20 minutes of valid samples
        valid -= 60 * HZ * 5                       # subtract 5 minutes
    mAI = trunc((mOSACount + mCSACount) * 360000 / valid) / 10
                                                   # all-int32 division, one truncated decimal
    mOSAIndex = mOSACount * 36000.0 / valid        # float64, no rounding
    mCSAIndex = mCSACount * 36000.0 / valid

if mOSACount + mCSACount > 0:
    mAVGSecOSA = (int) Math.Round(mSumMinOSA / (OSA+CSA))   # half-to-even, samples
```

- **The printed "AHI" is `mAI`: apneas only, over non-zero-pressure hours (minus 5
  minutes when that time exceeds 20 minutes), truncated to one decimal.** Verified
  against the daily report's printed 2.5.
- `valid` counts zeros out of the smoothed integer pressure, so blank blocks and mask-off
  zeros are excluded from the denominator.
- `mMaxSecOSA`/`mSumMinOSA`/`mAVGSecOSA` are in samples (÷10 for seconds); v2 of this
  viewer surfaces only `mAI`.

### Event ordering

`EventList` holds **all apneas in breath order, then all hypopneas in breath order** —
an `.EVT5` is not globally time-sorted (every corpus file shows exactly one descending
start step, at the apnea→hypopnea boundary). The port emits the same order, and the
oracle compares in file order, not sorted order.

## EVT5 file layout (from the `NewEventFile` serializer)

Constants: header size 4096, record size 20, `Pack = 1` sequential structs →
little-endian, declaration order, no padding. Verified structurally against all 69
corpus files (version, strides, zero-fill, `iOrder` = index, ms ≡ 0 mod 100, ordering,
gate-consistent length extremes).

**Header (offset 0, 4096 bytes, rest zero-filled):**

| offset   | type         | field            | value (write path)        |
| -------- | ------------ | ---------------- | ------------------------- |
| 0        | int32        | `ihVersion`      | 1                         |
| 4        | int32        | `ihSegmentCount` | count of non-blank blocks |
| 8 + 18·i | 18-byte each | per-session      | see below                 |

**Per-session record (18 bytes):** uint16 `BlockID`; int64 `StartTime` (.NET DateTime
ticks of block start); int64 `EndTime` (`start + PressList.Count * 1000 / hz` ms, int
division first).

**Event records (offset 4096, 20 bytes each, count = (fileLen − 4096) / 20):**

| offset | type   | field         | value                                                  |
| ------ | ------ | ------------- | ------------------------------------------------------ |
| +0     | uint16 | `iOrder`      | record index                                           |
| +2     | int64  | `iStart`      | start, **ms** from first session start (samples × 100) |
| +10    | int32  | `iLen`        | duration, **ms** (samples × 100)                       |
| +14    | uint8  | `iType`       | 0x15 OSA / 0x16 CSA / 0x17 HI                          |
| +15    | uint8  | `iValidation` | 0 auto (1 confirm / 2 delete are user edits)           |
| +16    | uint16 | `iBlockID`    | apneas: breath's block ID; hypopneas: 0                |
| +18    | uint8  | `iP1`         | 0                                                      |
| +19    | uint8  | `iP2`         | 0                                                      |

The test reader mirrors `ReloadEvents` + `FindEvents`: deserialize all records after
4096, drop `iValidation == 2`, preserve order. Fresh vendor-scored files have
`iValidation = 0` throughout.

## Module structure

**`src/parse/events.ts`** (new, pure, DOM-free like the rest of `src/parse/`):

```ts
export type ScoredKind = 'OSA' | 'CSA' | 'HYP'

export type ScoredEvent = {
  kind: ScoredKind
  start: number // sample index on the padded night timeline (10 Hz)
  len: number // samples
}

export function scoreEvents(table: BreathTable): ScoredEvent[]

export function ahiScored(
  events: ScoredEvent[],
  pressSmooth: Float32Array
): number
```

`scoreEvents` needs only the breath table (`CalEvents` + `CalculationHI` read nothing
else); `ahiScored` implements `GetAI`'s `mAI` arithmetic verbatim over the padded
smoothed pressure (the same `lowpassRoundF32` array v1's `buildNight` already computes).

**`src/types.ts`.** `Night` gains two fields, null together with `breath`:

```ts
scored: ScoredEvent[] | null
ahiScored: number | null
```

`ScoredEvent[]` is small (tens of entries) and crosses the worker boundary by structured
clone; no new transfers.

**`src/parse/metrics.ts`.** `buildNight` calls `scoreEvents`/`ahiScored` after
`reduceBreaths`, reusing the already-computed arrays. Existing fields (`events`, `ahi`,
everything v1 froze) are untouched.

**`src/test/evt5.ts`** (new, test-only): the minimal `.EVT5` reader above. It lives
under `src/test/` and never ships in the bundle.

## Timeline mapping

Scored events are produced on the padded night timeline (v1's zero-filled wall-clock
concatenation), so `start / 10` is seconds since the first session's start. The night
page already places sessions on the wall clock (`nightAxis.placeSessions`), so mapping a
scored event onto the strips and waveform is `firstSessionStartSec + start / 10` — no new
coordinate bookkeeping. Events can straddle or span inter-session gaps (see the vendor
quirks above); they are drawn as-is.

## Validation

Real recordings, `.EVT5` files, and values derived from them stay out of the repo, as
with v1.

- **`src/test/events.test.ts`** (committed, opt-in on `DS1_DIR`, run via
  `make test-events`): for every `.ds1` in the corpus with a sibling `.EVT5`, parse the
  `.ds1` with the vendor's 4096-byte chunk truncation (the same harness-only deviation
  v1's report oracle uses — the vendor generated the `.EVT5`s through that read path,
  while the viewer keeps whole files), run the scorer, and assert **per-event equality
  in file order**: same event count, and for each record the same type, start, and
  duration, exact. `.EVT5` stores milliseconds and the scorer works in 10 Hz samples;
  the test compares via the exact factor (100 ms per sample) with no rounding slack.
  All corpus nights, no sampling. Expected volume: 3042 events.
- **Report cross-check**, same test file: per-night scored apnea totals and `ahiScored`
  against `expected.json`'s statistical-report columns (13 nights), and the OSA/CSA
  split against the daily report's printed pair. This also settles transcription
  uncertainty #1 (whether the report prints `mAI` or the unrounded indices): if a night
  disagrees at the last decimal, compare both candidates and record the answer here.
- **`src/parse/events.test.ts`** (committed, CI-visible): synthetic breath tables
  pinning the boundaries — pause gates 95/495/150 (a 95-sample pause must not score; 96
  must; 149 splits CSA from OSA at the cap), the leak 700 gate, the CSA TV pattern, the
  open (30,70) entry/recovery vs closed [30,70] persistence bands, the `r3 > 70`
  recovery-overshoot abort, the ≥ 100-sample duration gate (99 no, 100 yes), the 25 s
  continuation stop, the apnea/hypopnea ordering, the uint16 length wrap, and the
  empty/null paths. These protect the port in
  CI; the EVT5 oracle proves it once.
- Tolerances: none. Per-event equality is exact or the port is wrong. Any night that
  cannot be made exact gets the v1 treatment: a stated, specific reason recorded in this
  spec, never a loosened assertion.

The screenshots of the vendor UI remain useful only as a rendering reference for the
span style; they carry no numeric weight.

### Validation outcome (2026-08-14)

- **Per-event equality: 3042 of 3042 events across all 69 corpus nights** — type,
  start, duration, file order, exact, no exclusions. The first run over-counted
  hypopneas (only hypopneas; apneas were exact corpus-wide from the start) on 40
  nights; the cause was the transcription omission recorded above (the `r3 > 70`
  recovery-overshoot abort, IL_01ea). One line in the port fixed all 40 nights; no
  constant was changed.
- **Report cross-check: passes** — per-night scored apnea count and `ahiScored` match
  the statistical report's 13 rows, and the daily report's OSA/CSA split matches. One
  exclusion: `2026-08-13`, whose `.ds1` gained sessions after the report was printed;
  its regenerated `.EVT5` matches our scorer exactly (verified per-event), so the stale
  report row — not the scorer — is the outlier.
- **Uncertainty #1 resolved: the report prints `mAI`** (all-int32 truncated apnea
  index), not the unrounded `mOSAIndex + mCSAIndex`. Decisive, not merely consistent:
  on 7 of the 12 checked nights the two candidates differ at the printed decimal
  (truncation vs rounding of the same quotient), and the printed value equals `mAI`
  on every one.

## UI

All new figures are estimates from the ported scorer and use the established estimated
register (lowercase labels; `<Estimated>`/info-tip provenance, one popup per element).

- **Summary**: the `avg AHI` KPI switches to the mean of `ahiScored ?? ahi` per night —
  each night's scored AHI when it has one, its device-flag figure otherwise. `AHI_TIP` is
  rewritten: it now describes re-scoring from the flow channel, names OSA/CSA/hypopnea, and
  states that hypopneas are scored and shown but not counted into the AHI figure (matching
  the vendor), plus the severity bands it already explains.
- **`NightTable`**: the `AHI` column shows `ahiScored ?? ahi`; the `apnea` column shows
  the scored apnea count with the device count in a tooltip.
- **`TrendChart`**: the AHI series uses `ahiScored ?? ahi`.
- **Night page event strip**: lanes become scored `OSA` / `CSA` / `hypopnea` plus the
  existing device lanes relabeled `apnea (device)` / `press up` / `press down`. Scored
  lanes render spans (start to end), not ticks. The chart title distinguishes the two
  provenances.
- **Waveform**: the flow pane draws the vendor-style span — a horizontal bracket over
  `[start, start + len]` with the label `OSA: 12.7s` (kind plus duration to one
  decimal) — when the event overlaps the visible window. Device apnea tick marks stay.

## Risks

- **The transcription is complete but the oracle is unforgiving.** 3042 events must
  match exactly; the plausible failure modes are the same as v1's (chunk-truncation
  interactions at the tail, off-by-one in the padded timeline, the small-breath merge's
  effect on `iNextInsp` vs raw `iInsp`), each now localized to specific events with
  specific timestamps to debug.
- **Report-AHI provenance** (uncertainty #1): `mAI` (truncated) vs the unrounded
  per-type indices. The 13-night cross-check settles it; the port ships `mAI` either
  way.
- **Unexercised edges**: the uint16 length wrap (corpus max is well below it) and a
  breath opening past the last real block exist in the code but not the data; synthetic
  tests pin the wrap, and the port asserts rather than guesses on the block lookup.
- **UI density**: six event-strip lanes (3 scored + 3 device) may crowd the 140 px
  strip; the plan may raise the strip height or merge the press-up/down lanes, a visual
  call with no numeric consequence.

## Definition of done

- `make typecheck && make test && make lint && make build` green; bundle within budget.
- `make test-diff` and `make test-reports` unchanged from their pre-feature state
  (existing behavior frozen; the known assertion-7 residual stays as documented).
- `make test-events DS1_DIR=~/Downloads/dreamsleep` passes per-event equality (type,
  start, duration, file order) on every corpus night, or this spec documents the
  specific exceptions and why.
- AHI/apnea figures in the UI switch to the scored values with estimated marking and
  provenance-labeled device lanes, per the UI section.
- No `any`; branded units; Prettier clean; no corpus-derived values committed beyond
  what the saved reports print and the aggregate counts/extremes quoted above.
