# Breath-derived metrics and event re-scoring

Design proposal, 2026-08-14. **For review — not yet approved.** Investigated autonomously;
the human directed the questions (reproduce P90/P95, apnea/AHI, mark events) and will decide
scope in the morning.

## Why this is one feature, not four

The open items from the shipped viewer — P90/P95, AHI/apnea count, automatic event marking —
plus the whole breath-derived metric family (tidal volume, respiratory rate, I:E, minute
ventilation) all depend on a **single missing subsystem: breath segmentation of the flow
channel.** Port that one piece and every one of these becomes computable. This spec covers
that subsystem and everything it unlocks.

The evidence that they share a root cause:

- **The vendor ignores the device's own apnea flags.** Measured across eight dated nights in
  the saved reports, the device's `0x9a` apnea count differs from the vendor's reported apnea
  count by a mean of 5.8 events, in **both directions** (12/08: device flags 23, vendor reports
  6; 09/08: device 16, vendor 9; 11/08: device 17, vendor 19). The correlation is loose. The
  decompiled `GetAI`/`CalEvents`/`CalculationHI` confirm the vendor re-scores events from the
  reconstructed breath list, never reading the stored flags. Our current AHI (device flags ÷
  hours) is therefore not the vendor's AHI and cannot be made so without the flow-based scorer.
- **P90/P95 are per-breath pressures, not sample-stream percentiles.** The vendor's
  "Horizontal Pressure P90/P95" runs ~1.0 cmH2O below our raw-sample percentiles (11/08: vendor
  6.3/6.9, raw P_A 7.3/7.5). A breath-segmentation experiment brackets the vendor values with
  the per-breath expiratory-minimum (low) and inspiratory-maximum (high) pressures — e.g. night
  26/07 vendor 6.0/6.1, expiratory 5.5/5.8, inspiratory 6.7/7.0 — so the vendor series is a
  per-breath pressure, but a crude segmenter can't pin which without the real algorithm.
- The `TBreath` struct the vendor fills per breath already carries `InsMaxPress`,
  `ExpMinPress`, `iTV`, `iBPM`, `iMV`, `iLeak`, `iIpAvgFlow`, `iInsp`, `iExp` — i.e. every one
  of these metrics is a reduction over the same per-breath list.

## What we now have that we didn't before

Two saved vendor reports (`~/Downloads/dreamsleep/Daily Report.docx`,
`Statistical Report.docx`) give **exact target values for dated files that exist in the
corpus** — turning a guessing game into test-driven development:

- Daily (11/08/2026): Avg 6.1, Max 8.5, Min 4.1, **P90 6.3, P95 6.9**; AHI 2.5 (OSA 14, CSA 5);
  Avg.TV 199, 95/90/50% TV 289/249/196; BPM 15.1, 95/90/50% 19.3/18.1/15.0; Avg.Leakage 14.8,
  95/90/50% 18.2/17.4/14.7; I:E 95/90/50% 1:1.7 / 1:1.5 / 1:1.2; Effective Duration 7.48 h.
- Statistical (01–13/08): per-night table of Duration, Avg Pressure, P90, P95, Max, AHI,
  Apnea, Avg Leakage, plus the 50/90/95% aggregates of every metric and Minute Volume.

Our decoder already reproduces Duration to the second and Avg/Max/settings exactly on these
same files, so the harness is trustworthy; only the breath-derived rows are missing.

## The algorithm, from the decompiled library

Entry points in `DP.Analysis.AnalysisFileV2` (IL already extracted):

- **`CalIsnpExp(flow, flow_f, flowBase_f)`** — segments breaths. Uses the two low-pass passes
  we already implement (`LowPass_Float`, α=50 for flow, α=3 for the baseline) and detects
  inspiration/expiration from where the smoothed flow crosses its baseline. Produces the
  `TBreath` list with `iInsp`/`iExp` sample indices, `InsMaxPress`/`ExpMinPress`, and tidal
  volume `iTV = round(Σ flow_above_baseline / 5)` per inspiration (or `/2` for `DataVer==0`).
- **`GetInspExpPress()`** — reduces the breath list to `InspPresP90`, `ExpPresP90/P95` via the
  `Percentile` helper we already ported (`floor(n·p/100)`-th order statistic). The displayed
  "Horizontal Pressure" P90/P95 are the **expiratory** series (the low ones).
- **`CalEvents` / `GetAI` / `CalculationHI`** — event scoring over the breath list:
  - **Apnea:** flow amplitude reduced > ~70% from the running baseline. Split OSA vs CSA
    (`ET_OSA=0x15`, `ET_CSA=0x16`) by whether breathing effort persists.
  - **Hypopnea (`ET_HI=0x17`):** amplitude reduced **30–70%** (the `ldc.r8 30.`/`70.` compares
    are explicit in `CalculationHI`) lasting **> 9.5 s** (`ldc.r8 9.5 cgt`, on a sample count
    divided by 10 Hz).
  - **Snore / Flat (`ET_SNORE`, `ET_FLAT`)** — flow-shape tests, lower priority.
  - **AHI** = (apnea + hypopnea count) ÷ **effective** hours, where effective duration excludes
    mask-off periods (the Daily report's 7.48 h vs 24.00 h total). Verified: 11/08 (14+5)/7.48
    = 2.54 ≈ 2.5; 13/08 1/1.79 = 0.56 ≈ 0.5.

None of this needs data we don't have — it is all a function of the two 10 Hz channels we
already decode.

## Proposed shape

- A new pure module `src/parse/breath.ts` consuming a `Session` (flow + pressure typed arrays)
  and producing a `Breath[]` list plus a `ScoredEvent[]` list. DOM-free and worker-agnostic,
  like the rest of `src/parse/`, so it is unit-testable and joins the differential harness.
- Extend the worker's `buildNight` to attach the breath list and scored events to the `Night`;
  extend metrics with the breath-derived aggregates.
- New differential fixtures: the two `.docx` reports are parsed once into a committed JSON of
  expected values (synthetic-safe: they contain no waveform, only derived numbers), and an
  opt-in test asserts our breath metrics match them within the reports' printed precision.
- **Verified-vs-estimated labelling** (per the original spec's constraint): breath-derived
  numbers are estimates from a heuristic port and must be visually marked distinct from the
  channel-exact metrics, and the P90/P95 tooltip caveat updated once they match.

## Honest risk

This is the hardest work in the project and the only part where exactness is not guaranteed:

- Breath segmentation is a heuristic; matching the vendor to the printed decimal may require
  iterating on details the IL under-specifies (baseline tracking window, minimum breath
  duration, how partial breaths at session edges are handled).
- Apnea OSA/CSA classification needs an effort proxy the IL derives from flow shape; this is
  the least certain piece and may land as "apnea count correct, OSA/CSA split approximate."
- Effective-duration definition (what counts as mask-off) must be reverse-engineered from the
  7.48 vs 24.00 gap; likely a leak or flow threshold.

Recommendation: scope v1 to **P90/P95 + TV + BPM + I:E + minute ventilation** (deterministic
reductions once breaths exist, directly checkable against the reports) and treat **apnea/AHI
re-scoring as a separate follow-on**, since its OSA/CSA split carries the most irreducible
uncertainty. Marking events on the waveform then uses whatever the scorer produces, clearly
labelled as this tool's detection.

## Open questions

- Exact `CalIsnpExp` baseline-tracking and breath-boundary rules (needs a closer IL read or a
  .NET decompiler — `monodis` gave enough to design from, not enough to transcribe).
- The effective-duration / mask-off threshold.
- Whether TV's `/5` divisor interacts with the flow-scale assumption (≈0.12 L/min per count);
  the reports' exact TV values (Avg 199, 95% 289) are the test that will settle the flow scale
  itself — a nice side benefit.
