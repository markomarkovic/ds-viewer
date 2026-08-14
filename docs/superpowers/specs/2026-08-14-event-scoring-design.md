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
3. **The scorer is a full transcription** of the vendor's `CalEvents`/`GetAI`/
   `CalculationHI` (and the helpers they call, notably the breathing-effort proxy that
   splits OSA from CSA), the same method that made v1 exact. No black-box fitting.
4. **The validation gate is per-event equality** — type, start, duration — against the
   vendor's own `.EVT5` output across the full corpus, not count-level agreement.

## What we already have

- **The inputs.** `Night.breaths` (the full `BreathTable`) was retained by v1 precisely
  for this scorer; its indices live on the zero-padded wall-clock night timeline. The
  smoothed flow arrays the scorer needs are recomputed the same way v1's `buildNight`
  already does.
- **A partial reading of the algorithm** (from the parent spec's first IL pass):
  - Apnea: flow amplitude reduced > ~70% from the running baseline; split OSA
    (`ET_OSA = 0x15`) vs CSA (`ET_CSA = 0x16`) by whether breathing effort persists.
  - Hypopnea (`ET_HI = 0x17`): amplitude reduced 30–70% (the `ldc.r8 30.`/`70.` compares
    are explicit in `CalculationHI`) lasting > 9.5 s (`ldc.r8 9.5 cgt`, on a sample count
    divided by 10 Hz).
  - AHI: the parent spec verified `(OSA + CSA) / duration_h` against two printed AHI
    values, which suggests hypopneas are excluded from the vendor's "AHI" despite the
    name. The transcription of `CalculationHI`/`GetAI` settles the arithmetic; nothing is
    assumed from the name.
    These are anchors for the full transcription, not a substitute for it.
- **A per-event oracle.** Loading `.ds1` files into the vendor software leaves a
  `DDMMYYYY.EVT5` beside each — its persisted scored-event list. One exists for every
  night of the corpus. First-pass reverse engineering of one file:
  - a header carrying a version/count prelude and per-session `DateTime` tick pairs;
  - a fixed-offset event array of 20-byte records: event start (ms), duration (ms), a
    type word matching the DLL's `ET_*` codes, and a sequence number.
  - The type tallies of the night with a printed OSA/CSA split match the report exactly.
    The layout above is inferred from bytes; the implementation must pin it by reading the
    DLL's own EVT5 serializer before the reader is written. If the serializer contradicts
    the inference, the serializer wins.
- **Proven infrastructure**: the opt-in differential-test pattern, the `expected.json`
  report oracle (statistical report: per-night apnea count and AHI for 13 nights; daily
  report: OSA 14 / CSA 5 / AHI 2.5 for its night), and the v1 numeric discipline
  (float32 stores, round-half-to-even, truncation at the vendor's points).

## Module structure

**`src/parse/events.ts`** (new, pure, DOM-free like the rest of `src/parse/`):

```ts
export type ScoredKind = 'OSA' | 'CSA' | 'HYP'

export type ScoredEvent = {
  kind: ScoredKind
  start: number // sample index on the padded night timeline (10 Hz)
  len: number // samples
}

export function scoreEvents(
  table: BreathTable,
  flowSmooth: Float32Array,
  flowBase: Float32Array
): ScoredEvent[]

export function ahiFrom(events: ScoredEvent[], hours: number): number
```

The exact `scoreEvents` signature follows the transcription — if the vendor's scorer
reads inputs beyond these arrays (e.g. the raw flow or pressure), the signature grows to
match; the plan records the final shape. `ahiFrom` implements the vendor's arithmetic
verbatim, whatever `CalculationHI` turns out to divide by, including its truncation.

**`src/types.ts`.** `Night` gains two fields, null together with `breath`:

```ts
scored: ScoredEvent[] | null
ahiScored: number | null
```

`ScoredEvent[]` is small (tens of entries) and crosses the worker boundary by structured
clone; no new transfers.

**`src/parse/metrics.ts`.** `buildNight` calls `scoreEvents` after `reduceBreaths`,
reusing the already-computed smoothed arrays. Existing fields (`events`, `ahi`,
everything v1 froze) are untouched.

**`src/test/evt5.ts`** (new, test-only): a minimal `.EVT5` reader used by the
differential test. It lives under `src/test/` and never ships in the bundle.

## Timeline mapping

Scored events are produced on the padded night timeline (v1's zero-filled wall-clock
concatenation), so `start / 10` is seconds since the first session's start. The night
page already places sessions on the wall clock (`nightAxis.placeSessions`), so mapping a
scored event onto the strips and waveform is `firstSessionStartSec + start / 10` — no new
coordinate bookkeeping. Events whose span falls entirely inside an inter-session gap
cannot exist (no breaths there); an event straddling a session seam is drawn as-is.

## Validation

Real recordings, `.EVT5` files, and values derived from them stay out of the repo, as
with v1.

- **`src/test/events.test.ts`** (committed, opt-in on `DS1_DIR`, run via
  `make test-events`): for every `.ds1` in the corpus with a sibling `.EVT5`, parse the
  `.ds1` with the vendor's 4096-byte chunk truncation (the same harness-only deviation
  v1's report oracle uses — the vendor generated the `.EVT5`s through that read path,
  while the viewer keeps whole files), run the scorer, and assert **per-event equality**:
  same event count, and for each event the same type, start, and duration, exact.
  `.EVT5` stores milliseconds and the scorer works in 10 Hz samples; the test compares
  in one unit via the exact factor (100 ms per sample) with no rounding slack.
  All corpus nights, no sampling.
- **Report cross-check**, same test file: per-night scored apnea totals and computed AHI
  against `expected.json`'s statistical-report columns (13 nights), and the OSA/CSA split
  against the daily report's printed pair.
- **`src/parse/events.test.ts`** (committed, CI-visible): synthetic breath tables and
  flow signals pinning the thresholds — the ~70% apnea bound, the 30–70% hypopnea band,
  the > 9.5 s duration gate (a 9.4 s reduction must not score; the exact boundary
  semantics come from the transcription), the OSA/CSA effort split on constructed
  effort/no-effort shapes, and the empty/null paths. These protect the port in CI; the
  EVT5 oracle proves it once.
- Tolerances: none. Per-event equality is exact or the port is wrong. Any night that
  cannot be made exact gets the v1 treatment: a stated, specific reason recorded in this
  spec (e.g. a tail event lost to the chunk-truncation deviation), never a loosened
  assertion.

The screenshots of the vendor UI remain useful only as a rendering reference for the
span style; they carry no numeric weight now that `.EVT5` provides positions and
durations.

## UI

All new figures are estimates from the ported scorer and use the established estimated
register (lowercase labels; `<Estimated>`/info-tip provenance, one popup per element).

- **Summary**: the `avg AHI` KPI switches to the mean of `ahiScored` over nights that
  have it (falling back to the device-flag figure when none do). `AHI_TIP` is rewritten:
  it now describes re-scoring from the flow channel, names OSA/CSA/hypopnea, and states
  that hypopneas are scored but (if the transcription confirms it) not counted into the
  AHI figure, plus the severity bands it already explains.
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

- **The effort proxy is the hardest transcription.** It is the one piece the parent spec
  called least certain. The per-event oracle turns "approximate split" into a debuggable
  list of specific misclassified events, but the IL may still be long; budget for it.
- **EVT5 layout assumptions.** Today's inference matched one night's structure and type
  tallies, but offsets, the meaning of the header words, and multi-session files must be
  pinned from the serializer. A wrong stride would misread every record.
- **Chunk truncation at the tail.** The vendor scored events over chunk-truncated reads;
  the harness reproduces that, but any interaction between truncation and the last
  breaths is a candidate for the first per-event diffs.
- **Thin hypopnea coverage.** The one night with a printed split contains a single
  hypopnea; if the corpus holds few `0x17` events overall, the hypopnea path leans on
  synthetic tests. Check the corpus-wide type histogram early and record it (as counts,
  not positions) in the plan.
- **AHI naming vs arithmetic.** The displayed figure may exclude hypopneas; the UI copy
  must describe what the number actually is once transcribed.

## Definition of done

- `make typecheck && make test && make lint && make build` green; bundle within budget.
- `make test-diff` and `make test-reports` unchanged from their pre-feature state
  (existing behavior frozen; the known assertion-7 residual stays as documented).
- `make test-events DS1_DIR=~/Downloads/dreamsleep` passes per-event equality on every
  corpus night, or this spec documents the specific exceptions and why.
- AHI/apnea figures in the UI switch to the scored values with estimated marking and
  provenance-labeled device lanes, per the UI section.
- No `any`; branded units; Prettier clean; no corpus-derived values committed beyond
  what the saved reports print.
