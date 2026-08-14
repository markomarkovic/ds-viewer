# Report generation

Design proposal, 2026-08-14. **For review — not yet approved.**

## Goal

Reproduce the vendor's two printable reports as first-class views in the viewer, so a user can
hand a clinician the same document without the Windows software. The vendor emits `.docx`; we
should emit a **print-optimised HTML view** the browser turns into PDF via Ctrl-P — no document
library, no dependency, consistent with the single-file premise.

Two reports, both captured from real vendor output in `~/Downloads/dreamsleep/*.docx`:

### Daily Report (one night)

Patient info block (name/age/gender/etc. — user-entered, optional), then:

- **Session:** start/end, total vs effective duration, equipment model, SN, mask-fit band,
  avg leakage.
- **Device setup:** work mode, PS, max/min pressure, EPR.
- **Pressure:** avg / max / min, and Horizontal Pressure P90 / P95.
- **Event information:** AHI, and a count + index table for OSA / CSA / Snore / Flat.
- **TV / BPM / Leakage:** avg and 95/90/50% each.
- **I:E:** 95/90/50%.
- Six embedded trend graphs (the `.wmf` images in the docx) — we already render these live, so
  the report reuses the same chart components as static snapshots.

### Statistical Report (a date range)

- Period, used days, used-days-≥-4-h, avg AHI, avg/total duration.
- 50/90/95% aggregates of pressure, leakage, TV, BPM, I:E, minute volume across the range.
- Treatment-duration compliance table (days, %, avg hours; and the ≥4 h subset).
- A per-night table: Date, Duration, Avg Pressure, P90, P95, Max, AHI, Apnea, Avg Leakage,
  Work Mode, Mask Fit — which is close to the table the overview page already shows.

## Dependency on the breath-metrics work

The channel-exact rows (duration, avg/max pressure, leak, mask-fit band, compliance, work mode)
can be reported **today** from what the viewer already computes. The breath-derived rows
(P90/P95, AHI, event table, TV, BPM, I:E, minute volume) are blank or marked "not computed"
until [breath metrics](2026-08-14-breath-metrics-design.md) lands. So this can ship in two
stages: a working report with the exact rows first, filled in as the breath work completes.

## Proposed shape

- A `report` route (hash `#report` / `#report/<night>`) rendering a print-styled layout;
  `@media print` CSS hides the app chrome and lays the report to page width. No new bundle
  weight of consequence — it reuses the existing charts and metrics.
- "Mask-fit band" needs the leak thresholds the vendor uses (`Low leak (15.0~35.0)` appears in
  the Daily report) — a small lookup to reverse-engineer from a few reports.
- Patient-info fields are optional local inputs, never persisted (consistent with the no-storage
  premise) — they exist only for the current print.

## Non-goals

- Not emitting `.docx`. HTML-to-PDF via the browser is lighter, dependency-free, and looks the
  same to a clinician.
- Not persisting patient info or reports — the viewer stays ephemeral.

## Open questions

- The exact mask-fit leak bands and the "effective duration" rule (shared with the breath-metrics
  spec).
- Whether the six per-report graphs should be the live interactive charts or flattened static
  SVG for cleaner printing (lean: static for print, to avoid interaction affordances on paper).
