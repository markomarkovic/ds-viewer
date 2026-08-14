# ds-viewer

A single-file HTML viewer and a Python decoder for `.ds1` sleep-therapy logs written by CPAP
machines that ship with the **DreamSleep** / **Records** PC software, plus a complete
description of the file format.

Developed and validated against a **DS-6 AUTO CPAP**.

The vendor software is Windows-only and shows you summary tables. This repo reads the same
SD-card files anywhere: the viewer is one HTML file that parses everything in your browser and
charts the 10 Hz pressure and flow waveforms; the CLI turns the same files into CSV for
whatever analysis you like.

**Live viewer: <https://okram.civokram.com/ds-viewer/>** — your files never leave the browser.

No vendor code or binaries are included or required. See [Legal](#legal).

## Status

- **Viewer** — `make build` emits `dist/index.html`, a self-contained browser app (see
  [Viewer](#viewer)).
- **`ds1.py`** — decoder, session summariser and CSV exporter. Works, validated (see below).
- **[`DS1_FORMAT.md`](DS1_FORMAT.md)** — the format specification.

Only `.ds1` is supported. The same software also reads `.ds3` and `.ds4`, which are handled by
different parsers in the vendor code and are **not** the same layout.

## Usage

Python 3.8+, no dependencies.

```sh
# per-session summary
./ds1.py 13082026.ds1

# waveform to stdout, same columns as the exported files
./ds1.py --csv 13082026.ds1 | head

# export everything: per-night waveforms + sessions.csv + events.csv
./ds1.py --export csv/ *.ds1
```

Summary output:

```
13082026.ds1  (1 session(s))
  2026-08-13 12:00:00  1.79 h  AUTO 6-20 cmH2O  ramp 5 min  humidity 1
    pressure  avg 6.1  median 6.2  max 7.5 cmH2O
    leak      median 19.4 L/min   peak flow 83 L/min
    events    {'APNEA': 4, 'PRESS_UP': 5, 'PRESS_DOWN': 7}   AI 2.2/h (device-flagged)
```

## Viewer

Use it at **<https://okram.civokram.com/ds-viewer/>**, grab `ds-viewer.html` from a
[release](https://github.com/markomarkovic/ds-viewer/releases) to run offline, or build it
yourself:

```sh
make setup   # once: toolchain via mise, deps via pnpm
make build   # emits dist/index.html
```

Open the file in any browser — `file://` works, no server needed — and drop your `.ds1`
files or the whole SD-card folder onto the page. Parsing happens entirely in-browser;
nothing is uploaded, nothing is stored between reloads.

**Overview page:** a KPI row (with an AHI explainer), trend charts for duration, P95, AHI
and median leak, and a table of nights sortable by every column. The date range is driven
three ways — presets, date pickers, or brushing the context strip — and the active range
stays highlighted on the strip. Hovering any chart shows a value tooltip and a cursor
linked across all of them. Dates follow your browser locale; times are always 24-hour.

**Night page** (each night has its own URL hash, so the browser back button and deep
links work): pressure, leak and event strips span the noon-to-noon day; brush any of
them to choose the waveform window, or click to centre it. Below, the flow and pressure
waveforms share a linked cursor with the strips, with window presets (30 s to 5 m),
First/Previous/Next/Last paging, brush-to-zoom, and the device's apnea markers drawn on
the traces. A time-in-pressure histogram with the cumulative curve and P90/P95 markers,
and a breath-metrics table (tidal volume, breath rate, I:E, minute ventilation, leakage)
close the page. Dark mode follows the browser and the charts retint live.

The summary's Horizontal Pressure P90/P95 and the night page's breath metrics
reproduce the vendor software's own analysis, validated against its saved
reports (see [Accuracy](#accuracy)); they are computed in-browser from the
recorded channels and marked as estimates in the UI. The histogram keeps the
standard time-weighted percentiles of the raw samples. Apnea counts are the
device's own markers, not the vendor software's re-scored events.

Development: `make dev`, `make test`, `make typecheck`, `make lint`, `make format`. The
parser is verified against `ds1.py` row-for-row with `make test-diff DS1_DIR=<data dir>`;
the breath metrics are verified against values extracted from the vendor's saved reports
with `make test-reports DS1_DIR=<data dir>` (see `tools/reports-to-json.py`).
Releases are built by CI on `v*` tags, which attach the single file and publish Pages.

## Export layout

`--export` writes three things:

| File                           | Rows            | Contents                                                                  |
| ------------------------------ | --------------- | ------------------------------------------------------------------------- |
| `DDMMYYYY.csv` (one per night) | 10 per second   | `session, t_s, timestamp, pressure_cmh2o, flow_lpm`                       |
| `sessions.csv`                 | one per session | start/end, duration, settings, pressure and leak statistics, event counts |
| `events.csv`                   | one per event   | `t_s`, timestamp, type, and the raw `d1,d2,d3` payload                    |

`--csv` writes the same waveform columns, with the same header, to stdout. It is pipe-safe:
closing the stream early (`| head`) exits quietly rather than raising.

Expect roughly 10 MB of CSV per hour recorded.

Two things to get right when loading these:

- **Use `t_s`, not `timestamp`, for anything quantitative.** `t_s` is elapsed seconds from the
  start of a session and is exact. `timestamp` is the device's real-time clock, which is often
  not set — see [Timestamps](#timestamps).
- **Split on `session`.** A night usually contains two or more sessions separated by real gaps
  (mask off). Concatenating a night's rows without splitting produces a false continuous trace.

## The format in brief

Full detail in [`DS1_FORMAT.md`](DS1_FORMAT.md). The short version:

A `.ds1` file is a flat stream of **4-byte records** — no header, no index, no checksums, no
compression. Byte 0 is a tag; all payload bytes are 7-bit clean.

```
type    = (byte0 & 0x78) >> 3        subtype = byte0 & 0x07
```

| type | tag       | meaning                                                           |
| ---- | --------- | ----------------------------------------------------------------- |
| 0    | `0x80–83` | session on/off date and time                                      |
| 1    | `0x88`    | device setting (key in byte 1, value `(byte2 << 7) + byte3`)      |
| 2    | `0x90`    | pressure + flow sample                                            |
| 3    | `0x98–9d` | events: pressure up/down, apnea, snore, hypopnea, flow limitation |

Samples are the bulk of the file, at a fixed **10 Hz**:

```
pressure = ((byte0 & 0x07) << 9) + (byte1 << 2) + ((byte2 & 0x60) >> 5)   # 0.1 cmH2O
flow     = ((byte2 & 0x1f) << 7) +  byte3                                  # ~0.12 L/min per count
```

Sessions are aligned to 256-byte boundaries; a file holds one to three of them.

## Accuracy

Checked against the vendor software's own per-day table across nine days, and against its
saved daily and statistical reports across thirteen nights:

| Quantity                               | Result                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Duration                               | Exact — one day matched to the second, the rest within a minute            |
| Avg. pressure                          | Exact on all nine days                                                     |
| Work mode, pressure settings           | Exact                                                                      |
| Max. pressure                          | Within 0.1 cmH2O, once the low-pass filter is applied                      |
| P90 / P95 (viewer)                     | Exact on all thirteen report nights                                        |
| TV, breath rate, I:E, leakage (viewer) | Match the reports to the printed digit (minute-volume means within 0.01 %) |
| Apnea count / AHI                      | **Not reproduced** — see below                                             |

Two things are worth understanding before you compare numbers with the vendor software:

- **P90/P95 are not percentiles of the sample stream.** The vendor software derives its
  "Horizontal Pressure" P90/P95 from a histogram of the smoothed pressure channel over the
  whole night. The viewer ports that analysis, plus the flow-channel breath segmentation
  behind the volume metrics, and matches the saved reports; `ds1.py` still reports only the
  time-weighted sample percentiles.
- **The apnea count shown by the vendor software is not the count stored in the file.** The
  device writes its own apnea markers, but the software ignores them and re-scores events from
  the flow waveform. On one night the software reported 10 apneas where the file contained 6; on
  another it reported 5 where the file contained 9. `ds1.py` reports what the _device_ recorded,
  labelled `device-flagged`, and does not re-score.

The file is ground truth for pressure, flow, settings and device-flagged events. Everything else
in that UI is the PC software's own re-analysis of the flow channel.

## Timestamps

Treat absolute timestamps as unreliable. On the machine this was developed against, the real-time
clock is not set: 54 of 69 files begin their first session at exactly `12:00:00`, which is the
vendor software's own fallback epoch, derived from the filename. Later sessions carry a real
free-running offset from that fictitious start, so a session can appear to "end" just before noon
the following day.

Durations and intra-session timing are exact regardless, because they come from the sample count
at a fixed 10 Hz, not from the clock.

Filenames are `DDMMYYYY.ds1` — day, month, four-digit year.

## Limitations

- Only the `SWITCH`, `PARAM`, `P_A` and `EVENT` record types are exercised. The format also
  defines `CP`, `STATE` (tidal volume, leak, temperature, humidity) and `SPO` (oximetry) records,
  but the device tested writes none of them, so that decoding is untested.
- The flow scale (~0.12 L/min per count) is derived from the vendor software's own tidal-volume
  formula and cross-checked against expected mask vent flow. It is not a figure read directly
  from a calibration constant, but the viewer's tidal-volume figures reproduce the vendor
  reports exactly under it, which pins the scale.
- Per-device calibration parameters (`PWM_*`, `P_*`, `F_*`) were unset on the test device.
- **Work-mode names are family-specific.** The vendor software maps the `WorkMode` setting to a
  mode name through a table selected by device family; `ds1.py` uses the `DS` branch, which is
  correct for a DS-6. On a machine from another family the same numeric code means a different
  mode, so the _label_ would be wrong even though the rest of the decode holds. For reference,
  the DS-6 reports `DEVICE_TYPE = 1` and `VER = 9` in its parameter records.
- Validated against a single **DS-6 AUTO CPAP** running in AUTO mode, over 69 nights
  (140 sessions, ~478 h). Bilevel and APCV modes are decoded but untested. Other machines in
  the same `DS` family will most likely work; report it if yours does or doesn't.

## How this was worked out

The record framing, session structure, both channels, the 12-bit field split, the pressure unit
and the 10 Hz rate were all derived from the files themselves, by looking at record alignment,
value distributions and the correlation between the pressure channel and the pressure-change
events.

The vendor's own analysis library then supplied the field _names_ and confirmed the layout, plus
four details that black-box analysis had got wrong or missed: the `<< 7` parameter packing, the
rule that selects the raw-vs-rescaled data path, the filter coefficients, and the work-mode
mapping.

## Legal

This documents a **data format**, which is not a copyrightable work — it is functional
information, not expression. The CJEU held exactly this in _SAS Institute v World Programming_
(C-406/10): the functionality of a program, its language, and the format of its data files are
not protected by copyright. The US equivalent is 17 USC §102(b).

Examining the vendor's software to determine those facts is expressly permitted for
interoperability purposes: EU Software Directive 2009/24/EC Art. 5(3) and Art. 6, whose
protections cannot be signed away (Art. 8). In the US, _Sega v. Accolade_ and _Sony v. Connectix_
treat intermediate copying for this purpose as fair use, and DMCA §1201(f) provides an
interoperability exception. No technological protection measure was circumvented: the software
ships unobfuscated and without any licence agreement or anti-reverse-engineering term.

This repository contains **no vendor code, no binaries, and no decompiled source** — only a
specification written from scratch and an independent implementation.

Your recordings are your own data.

## License

Code and documentation in this repository are MIT licensed — see [`LICENSE`](LICENSE).

The format description itself is a statement of fact about an interface and is not claimed as
property by anyone; the licence covers this repository's particular expression of it.

## AI disclosure

This project — the reverse engineering, the format specification, `ds1.py`, the viewer, and
this documentation — was written by Claude (Anthropic's model) working in Claude Code,
directed and reviewed by a human. The scope, priorities and design calls were human;
the analysis and implementation were AI.

Correctness does not rest on trusting either party: the parser is verified row-for-row
against the reference decoder across the full test corpus (17.2 M samples), and the
reference decoder is itself checked against the vendor software's own output (see
[Accuracy](#accuracy)). Bugs are still possible — report them like any other.

## Disclaimer

Not a medical device and not medical software. Nothing here is validated for clinical use. Do not
use it to make decisions about your therapy — discuss those with the clinician who prescribed it.
