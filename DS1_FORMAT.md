# `.ds1` file format (DreamSleep CPAP)

Reverse-engineered from the data plus `DP.Analysis.dll` inside `DreamSleep 1.0.25EN.exe`
(Inno Setup installer → .NET/WPF app). The parser is `DP.Analysis.AnalysisFileV2`;
`AnalysisFile.CreateAnalysisFile` routes `.ds4`→V4, `.ds3`→V3, **everything else (incl. `.ds1`) → V2**.

Corpus: 69 files / 140 sessions / ~478 h of recording from a **DS-6 AUTO CPAP**, read with
Records V1.0.25. Everything below marked "observed" or "example" refers to that device.

## Container

- Filename is `DDMMYYYY.ds1` (day, month, 4-digit year). The app parses it as
  `Substring(0,2)`=day, `(2,2)`=month, `(4,4)`=year.
- Pure stream of **fixed 4-byte records**, no header, no footer, no checksums. There are no
  multi-byte integer fields, so endianness never arises.
- File size is always a multiple of 256 bytes; the device flushes in sectors, and a new
  session block is started on a 256-byte boundary. The app reads in 4096-byte chunks.
- Every byte of a record has bit 7 clear except byte 0 (7-bit-clean payload, MIDI-style).

## Record header

```
byte0 =  1 t t t t s s s       bit 7 always set
         │ └──┬──┘ └─┬─┘
         │    │      └── subtype = byte0 & 0x07
         │    └───────── type    = (byte0 & 0x78) >> 3
         └────────────── record marker
```

| type | name     | tag bytes   | meaning                              |
| ---- | -------- | ----------- | ------------------------------------ |
| 0    | `SWITCH` | `0x80–0x83` | session on/off date & time           |
| 1    | `PARAM`  | `0x88`      | device setting (key in byte1)        |
| 2    | `P_A`    | `0x90`      | **pressure + airflow sample**        |
| 3    | `EVENT`  | `0x98–0x9d` | respiratory / pressure events        |
| 4    | `CP`     | `0xa0`      | not present in these files           |
| 5    | `STATE`  | `0xa8`      | not present in these files           |
| 6    | `SPO`    | `0xb0`      | oximeter, not present in these files |

## type 0 — SWITCH (session boundaries)

`sub = byte0 & 7`, payload is `(byte1, byte2, byte3)`:

| sub | name       | payload               |
| --- | ---------- | --------------------- |
| 0   | `ON_DATE`  | year-2000, month, day |
| 1   | `ON_TIME`  | hour, minute, second  |
| 2   | `OFF_DATE` | year-2000, month, day |
| 3   | `OFF_TIME` | hour, minute, second  |

A session ("block") = `0x80 0x81` + `PARAM`s + samples/events + `0x82 0x83`.
Multiple sessions per file (1–3 seen); the **last block may have no OFF marker**
(power cut / card pulled), and trailing samples after an OFF marker up to the next
256-byte boundary are buffer flush.

## type 1 — PARAM

```
key   = byte1
value = (byte2 << 7) + byte3      # note: <<7, NOT <<8
```

Key table (from `AnalysisFile.FF_ID_PARAM_*`). The "example" column gives the values observed on
the test device, which is what pins down each field's scale:

| key                 | name                    | example           | interpretation                                                                                                                                                                                                |
| ------------------- | ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0x00                | RampTime                | 5 (20 in 2 files) | minutes                                                                                                                                                                                                       |
| 0x01                | HumidityLevel           | 1 / 2 / 3         |                                                                                                                                                                                                               |
| 0x02                | AutoOn                  | 1                 |                                                                                                                                                                                                               |
| 0x03                | AutoOff                 | 1                 |                                                                                                                                                                                                               |
| 0x04                | WorkMode                | 3                 | **AUTO** — `AnalysiHelper.GetModel` does `switch(WorkMode-2)`; the `DS` branch (correct for a DS-6) is 2 CPAP, 3 AUTO, 4 S, 5 ST, 6 T, 7 APCV. Other device families use a different table for the same codes |
| 0x05                | Pressure                | 60                | 6.0 cmH2O (fixed-CPAP setpoint)                                                                                                                                                                               |
| 0x06                | MaxPress                | 200               | 20.0 cmH2O                                                                                                                                                                                                    |
| 0x07                | MinPress                | 60                | 6.0 cmH2O                                                                                                                                                                                                     |
| 0x08                | IPAP                    | 250               | 25.0 cmH2O                                                                                                                                                                                                    |
| 0x09                | EPAP                    | 100               | 10.0 cmH2O                                                                                                                                                                                                    |
| 0x0a                | BackRate                | 20                | bpm                                                                                                                                                                                                           |
| 0x0b                | InspTime                | 33                |                                                                                                                                                                                                               |
| 0x0c                | InspTriggle             | 3                 | pressure rise time index                                                                                                                                                                                      |
| 0x0d                | ExpLevel                | 3                 |                                                                                                                                                                                                               |
| 0x0e                | HZ                      | 100               | _not_ the sample rate — V2 hardcodes 10 Hz                                                                                                                                                                    |
| 0x0f                | DEVICE_TYPE             | 1                 | device family selector; 1 on the DS-6                                                                                                                                                                         |
| 0x10                | VER                     | 9                 | firmware/format version                                                                                                                                                                                       |
| 0x11                | InspSense               | 3                 |                                                                                                                                                                                                               |
| 0x12                | _(undefined)_           | 1                 | no constant for it in the DLL                                                                                                                                                                                 |
| 0x13                | PressUnloading          | 0                 | EPR / exhale relief, off                                                                                                                                                                                      |
| 0x14,0x18,0x1c      | PWM_4 / PWM_10 / PWM_25 | 16383             | calibration, unset (`0x7F,0x7F`)                                                                                                                                                                              |
| 0x20,0x24,0x28,0x2c | P_0 / P_4 / P_10 / P_25 | 16383             | calibration, unset                                                                                                                                                                                            |
| 0x30,0x34,0x38,0x3c | F_0 / F_4 / F_10 / F_25 | 16383             | calibration, unset                                                                                                                                                                                            |

Other defined-but-absent keys: 0x15 `PRESS_DECLINE_TIME`, 0x19 `IP_TIME`,
0x1a `TV_SWITCH`, 0x1b `TV_VALUE`, 0x21 `PRESS_DIFFER`, 0x25/0x26 `AUTOS_MIN/MAX_PRESS`,
0x29/0x2a `APCV_MAX_IPRESS`/`MIN_EPRESS`.

## type 2 — P_A (the waveform; ~99.7% of the file)

Exactly as `AnalysisFileV2.DecodePA`:

```
pressure = ((byte0 & 0x07) << 9) + (byte1 << 2) + ((byte2 & 0x60) >> 5)   # 12 bit
flow     = ((byte2 & 0x1f) << 7) +  byte3                                  # 12 bit
```

- **Sample rate is a hardcoded 10 Hz** (`HZ = 10`, `MinuteData = 300 * HZ`).
  Timestamp of sample _i_ in a block = `ON_TIME + i/10 s`.
  Measured against the OFF markers the implied rate is 9.9995–10.25 (median 10.008),
  i.e. the device clock drifts a few seconds per session; the app ignores this.
- `.ds1` sets `DataVer = 1` (chosen from the **last character of the filename**).
  With `DataVer == 1` the raw values are used as-is. (`.ds2`/`DataVer == 0` instead applies
  `p = round(p*350/3250 - 5)` and `f = round(f*1600/2600 - 300)`, clamped at `f ≥ 10`.)
- **Pressure unit: 0.1 cmH2O.** Confirmed three ways — the app clamps it against
  `iMaxPress` (=200) and discards samples > 300, and the EVENT records use the same units.
- **Flow unit: ≈ 0.12 L/min per count** (equivalently 2 mL/s), _not_ zero-based.
  Derived from the app's own tidal-volume formula: `TV_mL = round(Σ flow_above_baseline / 5)`
  over an inspiration at 10 Hz. Cross-check: the resting baseline here is 160–205 counts
  ≈ 19–25 L/min, which is exactly the intentional vent flow of a vented mask at 6–8 cmH2O.

The app derives its traces with a two-pass (forward+backward) EMA `y = (prev*(100-a) + x*a)/100`:

| trace                      | `a` |
| -------------------------- | --- |
| pressure                   | 20  |
| flow                       | 50  |
| flow **baseline** (→ leak) | 3   |

Leak is `baseline_flow * sqrt(pressure_cmH2O)` (`getCurLeak`).

## type 3 — EVENT

`sub = byte0 & 7`, then `d1 = byte1`, `d2 = byte2`, `d3 = byte3`.

| sub | tag  | name                   | payload seen                                          |
| --- | ---- | ---------------------- | ----------------------------------------------------- |
| 0   | 0x98 | `PRESS_UP`             | d1 = pressure before, d2 = pressure after (0.1 cmH2O) |
| 1   | 0x99 | `PRESS_DOWN`           | same                                                  |
| 2   | 0x9a | `APNEA`                | d1 = length (always 10 here), d2 = d3 = 0             |
| 3   | 0x9b | `SNORE`                | not present                                           |
| 4   | 0x9c | `HYP`                  | not present                                           |
| 5   | 0x9d | `FH` (flow limitation) | not present                                           |

Only subtype 2 is actually kept by the app: `TEvent { iStart = current sample index, iLen = d1 }`,
and indices are per-hour-normalised with `36000` (= 3600 s × 10 Hz) for the AHI/AI figures.
Pressure-change events are informational — the pressure channel already carries them.

The typical APAP signature is visible directly: `PRESS_DOWN` steps of −3 (0.3 cmH2O)
every ~3010 samples (≈5 min, the `MinuteData` window), and `PRESS_UP` steps of +6
immediately after an `APNEA` record.

## Cross-check against Records V1.0.25

Compared against the vendor software's own per-day table, across nine consecutive days:

| quantity                                                                                | agreement                                            | how the app derives it                                                                      |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Duration**                                                                            | ✅ exact (one day to the second, rest within ~1 min) | `Σ samples / 10 Hz` over all sessions in the file                                           |
| **Work Mode**                                                                           | ✅ exact (`AUTO`)                                    | PARAM 0x04                                                                                  |
| **Avg. Pressure**                                                                       | ✅ exact on all 9 days                               | mean of the raw pressure channel, **truncated** to int in 0.1 cmH2O                         |
| **Max. Pressure**                                                                       | ≈ within 0.1 on 9/9                                  | max **after** the α=20 low-pass (raw max runs 1–2 cmH2O high)                               |
| **P90 / P95**                                                                           | ✅ exact, 13/13 report nights (viewer port)          | histogram of the α=20-smoothed pressure over the whole night — see below                    |
| **Tidal volume / breath rate / inspiration:expiration ratio / minute volume / leakage** | ✅ validated against the saved reports (viewer port) | per-breath lists from flow-channel segmentation (`CalIsnpExp`/`GetInspExpPress`)            |
| **Apnea / AHI**                                                                         | ❌ not reproduced                                    | the app **ignores the device's stored `APNEA` records** and re-scores from the flow channel |

Two things this pins down:

- **The reported P90/P95 ("Horizontal Pressure") are not per-breath statistics.** `CalPress`
  builds a 301-bin histogram of `trunc(smoothed pressure)` clamped into `[40, 300]` over the
  whole night (sessions joined with zero-filled wall-clock gaps, whose zeros clamp into the
  40 bin); P90/P95 are the first bins whose cumulative share, in permille rounded
  half-to-even, reaches 900/950. The per-breath `InsMaxPress`/`ExpMinPress` fields exist but
  never feed the reported figures. The reported quartets — tidal volume, breath rate,
  inspiration:expiration ratio (I:E), minute volume, leakage —
  _do_ come from per-breath lists built by `CalIsnpExp`/`GetInspExpPress` —
  `Percentile(seq, p)` = sort, take index `len*p/100` (integer division), truncate to int;
  averages zero out values above an outlier bound before a truncating f32 mean
  (`CalculatedValue`), and reported leakage is the breath-onset smoothed flow in raw counts
  ÷ 10. The viewer ports this pipeline (`src/parse/breath.ts`) and matches the app's saved
  reports — P90/P95 exactly on all 13 report nights; the full transcription lives in
  [`docs/superpowers/specs/2026-08-14-breath-metrics-v1-design.md`](docs/superpowers/specs/2026-08-14-breath-metrics-v1-design.md).
- The **Apnea count in the software is not what the device wrote.** On one night the app reported
  10 apneas where the file contained 6 `0x9a` records; on another, 5 where the file contained 9.
  `AnalysisData` keeps `0x9a` only as `TEvent{iStart, iLen}`, and `GetAI`/`CalEvents`/`CalculationHI`
  then score `ET_OSA`/`ET_CSA`/`ET_HI` from the re-derived breath list. The displayed
  AHI is exactly `apnea_count / duration_hours` truncated to 1 dp — no hypopnea term.

So the file gives you the ground truth (pressure, flow, device-flagged events); everything else in
that UI is the PC software's own re-analysis of the 10 Hz flow channel.

## Caveats

- **Timestamps are device-RTC and not trustworthy in absolute terms.** In 54 of 69 files
  the first block starts at exactly `12:00:00`, which is the app's own fallback epoch
  (`InitBlock(..., new DateTime(yyyy, MM, dd, 12, 0, 0))` built from the filename).
  Later blocks in the same file carry a real free-running offset from that point.
  On the test corpus, file mtimes ran +4 h from the recorded OFF time.
- The device writes nothing for the STATE/SPO/CP record types, so temperature, humidity,
  measured leak, TV and SpO2 are not stored — they are all recomputed by the PC software
  from the two 10 Hz channels.
