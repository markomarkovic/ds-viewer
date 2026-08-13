# ds-viewer: single-file HTML viewer for `.ds1` CPAP logs

Design, 2026-08-13.

## Goal

A single self-contained `.html` file that reads `.ds1` sleep-therapy logs entirely in the
browser and presents night-over-night trends plus a drill-down into any night's 10 Hz
waveform. No install, no server, no upload — the file works when double-clicked from disk.

It replaces the Windows-only vendor software (Records / Play Back V1.0.25) for reviewing
one's own data, on any platform.

## Scope

**In:**

- Drag-and-drop of individual files *or* a whole folder.
- Per-night summary: duration, pressure statistics, leak, device-flagged events.
- Trend charts across nights, with a visual date-range selector.
- Sortable table of nights.
- Per-night drill-down: full-night overview strip, pressure histogram with cumulative
  distribution, and a zoomable pressure/airflow waveform.

**Out (v1):**

- Anything requiring breath segmentation — tidal volume, respiratory rate, minute
  ventilation, per-breath annotations. Deferred deliberately; see *Metrics*.
- OSA/CSA classification and computed event durations.
- Persistence between reloads.
- Editing or annotating data.
- `.ds3` and `.ds4` support (different formats, different parsers).

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Language | **TypeScript, `strict`** | The recurring hazard in this format is unit confusion — pressure stored in 0.1 cmH2O, flow in raw counts, time appearing as sample index, elapsed seconds and wall clock. Branded types make those mutually unassignable, so the class of bug most likely to produce plausible-but-wrong output becomes a compile error. Vite and Vitest both handle TS natively via esbuild. |
| Framework | **Preact** | State here is app-shaped — file set → nights → filter → selection → viewport — with derived values at each level. Vite means the no-build argument for Alpine is moot. Preact is also smaller (~4 KB gzip vs ~15 KB) and gives clean `useRef`/`useEffect` for driving an imperative canvas chart. |
| Charts | **uPlot** | Built for time-series at millions of points, canvas-based, ~16 KB gzip, with zoom/pan built in. Chart.js struggles at this scale; ECharts (~1 MB) is untenable inside a single file. Bar paths mean one library covers both trend and waveform charts. |
| CSS | **PicoCSS** | Classless semantic styling; keeps markup clean and the bundle small. |
| Bundling | **Vite + vite-plugin-singlefile** | Inlines everything into one `dist/index.html`. |
| Package manager | **pnpm** | Lockfile committed. `packageManager` field in `package.json` pins pnpm's own version so Corepack resolves it identically everywhere. |
| Dependency versions | **Exact pins, no ranges** | Every dependency written as `"1.2.3"`, never `^1.2.3`. Enforced by `save-exact=true` in `.npmrc` so future `pnpm add` calls cannot reintroduce a range. A viewer whose whole premise is a reproducible single file should not have its output drift because a transitive minor bumped. |
| Parsing | **Web Worker** | ~70 MB of binary across 69 files would visibly freeze the main thread. |
| Persistence | **None** | Re-dropping costs ~2 s. Avoids a storage layer, works identically on `file://` and `https://`, and leaves no health data in the browser profile. (Chrome also blocks IndexedDB on `file://`, which would have broken the single-file premise.) |
| Memory strategy | **Retain all samples** | 17.2 M samples × 2 channels as `Uint16Array` is ~69 MB — comfortable. Buys instant drill-down with no re-parse. |

Estimated single-file weight: **250–350 KB**.

## Toolchain

Runtime versions are pinned in three places that must agree, each serving a different
audience:

| File | Pins | Read by |
|---|---|---|
| `mise.toml` | `node = "24"` (current LTS), `pnpm = "11"` | Developers with mise; provisions the tools |
| `package.json` → `engines` | `node >=24`, `pnpm >=11` | npm/pnpm and CI; fails loudly on a wrong runtime |
| `package.json` → `packageManager` | `pnpm@11.9.0` | Corepack; guarantees an identical pnpm |
| `.npmrc` | `save-exact=true` | pnpm; stops a future `pnpm add` reintroducing a range |

Node 24 is the active LTS line as of August 2026. `mise.toml` tracks the LTS major so
patch updates arrive without editing, while application dependencies stay exactly pinned —
the toolchain and the dependency graph want opposite policies here.

### Makefile

A `Makefile` is the single entry point for both halves of the repo, so nobody has to
remember whether a task is a pnpm script or a Python invocation. `make help` is the default
target and self-documents.

| Target | Does |
|---|---|
| `make setup` | `mise install` then `pnpm install --frozen-lockfile` |
| `make dev` | Vite dev server |
| `make build` | Production build to `dist/index.html` |
| `make test` | Vitest, unit only |
| `make test-diff` | Opt-in differential test against real data (`DS1_DIR=...`) |
| `make typecheck` | `tsc --noEmit` |
| `make format` | `prettier --ignore-unknown --write .` |
| `make lint` | Static checks, including `prettier --check` |
| `make export` | Wraps `ds1.py --export`, so the CLI is reachable the same way |
| `make clean` | Removes `dist/` and caches |

Vite scripts stay in `package.json`; the Makefile delegates rather than duplicating them.

Note that `tsc` is a *separate* step, not part of `make build`. Vite strips types via esbuild
without checking them, so a build succeeding proves nothing about type correctness.
`make typecheck` runs in CI and belongs in the pre-commit path.

### Type conventions

- `strict: true`, plus `noUncheckedIndexedAccess` — the code indexes typed arrays constantly
  and the latter is what forces those reads to be handled honestly.
- Type-only imports use `import type { ... }`.
- Prefer `type` over `interface`; reach for `interface` only where declaration merging is
  actually needed.
- Branded types for units and identifiers, converted and branded at accessor boundaries.
- No `any`. Where a shape genuinely is unknown — the worker message boundary, `DataTransfer`
  entries — use `unknown` and narrow explicitly.

### Formatting

Prettier, configured in `.prettierrc`: no semicolons, single quotes, 80 columns, `es5`
trailing commas, with `prettier-plugin-organize-imports`. `.editorconfig` carries the same
2-space / LF / trailing-newline rules for editors that read it. Both are already committed.

`make format` runs `prettier --ignore-unknown --write .`. `.prettierignore` excludes the
lockfile and `dist/` — the built artifact is a single ~300 KB file with everything inlined,
so formatting it is slow and meaningless.

Two consequences of that config worth knowing up front:

- `prettier-plugin-organize-imports` drives the TypeScript language service, so it only acts
  on files covered by a `tsconfig`, and it drops import *bindings* it considers unused. Bare
  `import 'x'` forms are preserved. That is what keeps the two stylesheet imports — PicoCSS
  and uPlot — intact; they are the only side-effect imports the app should ever have.
- Markdown uses Prettier's default `proseWrap: "preserve"`, so existing line breaks in this
  spec and the README stay put. Tables get realigned; fenced code blocks, including the ASCII
  layout diagrams, are left alone.

### Build provenance

Both version sources are used, because they answer different questions:

```ts
// vite.config.ts
import { execSync } from 'node:child_process'
import pkg from './package.json'

const git = (cmd: string, fallback: string) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return fallback
  }
}

const commit = git('git rev-parse --short HEAD', 'unknown')
const dirty = git('git status --porcelain', '') === '' ? '' : '-dirty'

export default defineConfig({
  base: './',
  plugins: [preact(), viteSingleFile()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_COMMIT__: JSON.stringify(commit + dirty),
  },
})
```

`package.json` `version` is the canonical release number: human-set, deliberate, bumped on
release. The git hash is build provenance, and the `-dirty` suffix records that a build came
from uncommitted changes — which is precisely the build you most need to be able to identify
later. The UI shows both in a footer, so a screenshot carries its own provenance. That
matters more than usual here: the single-file artifact travels detached from the repository,
and the format it decodes is reverse-engineered, so "which build produced this number" is a
question that will eventually be asked in earnest.

Deriving the version from git alone was considered and rejected. `git describe --tags` fails
on a shallow checkout — `actions/checkout` defaults to `fetch-depth: 1` and fetches no tags —
and the natural fallback, `git rev-list --count HEAD`, then returns `1` and yields a
confident, wrong `0.0.1`. A version scheme whose failure mode is silently lying is the wrong
one. The release workflow must still set `fetch-depth: 0` for the hash to be meaningful.

`base: './'` is required, not cosmetic: without it the artifact cannot resolve anything when
opened over `file://`, which is the entire premise.

Two supporting details that are easy to miss: importing `package.json` from `vite.config.ts`
needs `resolveJsonModule` in the Node-side tsconfig, and the injected globals need
`declare const __APP_VERSION__: string` (and the same for `__GIT_COMMIT__`) in `src/env.d.ts`
or `tsc` rejects every use.

## Architecture

### Repo layout

The web app lives at the repo root; `ds1.py` remains the reference CLI.

```
ds1.py  DS1_FORMAT.md  README.md  LICENSE
Makefile  mise.toml  .npmrc  .editorconfig  .prettierrc  .prettierignore
package.json  pnpm-lock.yaml  tsconfig.json  vite.config.ts  index.html
src/
  env.d.ts            declarations for the injected build-time globals
  types.ts            branded units and the shared data model
  parse/ds1.ts        ArrayBuffer -> sessions.  Pure, no DOM.
  parse/metrics.ts    summaries, lowpass, histogram, percentiles
  parse/decimate.ts   (array, from, to, width) -> min/max envelope
  parse/worker.ts     message protocol only; logic lives in the modules above
  load/dropzone.ts    webkitGetAsEntry recursion + <input webkitdirectory>
  ui/                 App, Summary, TrendChart, RangeSelector, NightTable,
                      NightDetail, Waveform, Histogram  (.tsx)
  state.ts            useReducer store
  test/fixtures/      synthetic .ds1 and golden output
```

`src/parse/` is DOM-free and worker-agnostic, so it runs headless under Node via Vitest with
no browser and no worker harness. That is what makes
it testable and what allows differential testing against `ds1.py`.

### Data model

A **night** is one file, which the vendor's own 24-hour `12:00:00 → 12:00:00` window
confirms is a noon-to-noon period. Sessions nest inside it.

```ts
// src/types.ts
type Brand<T, B> = T & { readonly __brand: B }

type Deci      = Brand<number, 'Deci'>       // 0.1 cmH2O, as stored on disk
type CmH2O     = Brand<number, 'CmH2O'>      // display units
type Counts    = Brand<number, 'Counts'>     // raw flow, as stored on disk
type Lpm       = Brand<number, 'Lpm'>        // Counts * 0.12
type SampleIdx = Brand<number, 'SampleIdx'>  // 10 Hz index within a session
type Seconds   = Brand<number, 'Seconds'>    // elapsed within a session

type Night = {
  name: string                    // filename stem, DDMMYYYY
  date: Date
  sessions: Session[]
  hours: number
  samples: number
  press: { avg: Deci; median: Deci; p90: Deci; p95: Deci; max: Deci }
  histogram: Uint32Array          // 301 bins, 0..30.0 cmH2O at 0.1 resolution
  leakMedian: Lpm
  events: { apnea: number; pressUp: number; pressDown: number }
  ahi: number
  partial: boolean                // true if the file was truncated
}

type Session = {
  start: Date                     // device RTC, nominal - see Timestamps
  end: Date
  params: Map<ParamKey, number>
  press: Uint16Array              // Deci, full 10 Hz
  flow: Uint16Array               // Counts, full 10 Hz
  leak: Float32Array              // Lpm, 1 Hz
  events: DeviceEvent[]
}

type DeviceEvent = {
  index: SampleIdx
  kind: 'PRESS_UP' | 'PRESS_DOWN' | 'APNEA' | 'SNORE' | 'HYP' | 'FH'
  d1: number; d2: number; d3: number
}
```

Both channels are 12-bit and non-negative, so `Uint16Array` is exact and half the size of
`Float32Array`.

The brands cannot ride on typed-array elements — `Uint16Array` yields plain `number`. So
the discipline is that **accessors convert and brand at the boundary**: a bare
`session.press[i]` is untyped by construction, and code reads it through helpers like
`pressureAt(session, i): CmH2O`. That is where the 0.1 divisor and the 0.12 L/min factor
live, each in exactly one place.

Memory for 69 nights: pressure 34 MB + flow 34 MB + leak 7 MB ≈ **76 MB resident**.

### Pipeline

```
drop → recursive File collection
     → worker, per file → parse records → build typed arrays
                        → metrics: histogram, percentiles, leak baseline, summary
                        → postMessage({night}, [transferables])
     → main thread appends the night and re-renders
```

Results stream back **per file**, so nights appear progressively rather than after all 69.
Typed arrays cross the boundary by transfer, so there is no copy.

Two consequences worth stating explicitly:

- The min/max decimation needed to draw a 6-hour trace at ~1200 px **is** the inspiratory /
  expiratory pressure envelope the vendor shows as separate IPAP/EPAP traces. One
  mechanism serves both purposes; no breath detection required.
- Percentiles come from the 301-bin histogram, not from sorting 250k samples per night —
  exact time-weighted percentiles at 0.1 cmH2O resolution, O(n), no allocation.

Below the pixel threshold (a 30 s window is 300 samples, fewer than the pixel width)
decimation is skipped and raw samples are drawn.

The leak baseline is a two-pass α=0.03 EMA. It is slow by construction, so it is computed
once in the worker, retained at 1 Hz, and the full-resolution copy discarded.

## Metrics

Every displayed number must be derivable directly from the two channels with no heuristic
step. This is a deliberate constraint, not an accident of scope.

| Metric | Definition |
|---|---|
| Duration | sample count / 10 Hz, summed across a night's sessions |
| Avg pressure | mean of the pressure channel, truncated to 0.1 cmH2O |
| Median / P90 / P95 | time-weighted percentiles read off the histogram |
| Max pressure | maximum after the α=0.20 two-pass EMA |
| Leak | α=0.03 two-pass EMA baseline of the flow channel, × 0.12 L/min per count |
| Apnea / AHI | device-flagged `0x9a` records; AHI = count / hours |

**These will not match the vendor software's P90/P95**, which are consistently lower than
any pressure series derivable from the file. That is a known, unresolved discrepancy — see
*Open questions*. Displayed percentiles use the standard time-weighted definition and must
be labelled as this tool's own, not presented as reproducing the vendor's.

Breath-derived metrics are excluded from v1 because they are the numbers most likely to be
quietly wrong and the hardest to verify. The architecture leaves a clean seam: a breath
segmentation module consuming `Session.flow` can be added without touching the parse
pipeline. If added, estimated values must be visually distinguished from measured ones.

## User interface

Single scrolling page; PicoCSS semantics.

```
┌────────────────────────────────────────────────┐
│ 69 nights · 478 h · 01/06–13/08     [+ files]  │  slim header after load
├────────────────────────────────────────────────┤
│  used days   avg dur   avg P95   avg AHI  leak │  KPI row, obeys filter
├────────────────────────────────────────────────┤
│ [7d] [30d] [90d] [all]   from [__] to [__]     │
│ ▁▃▅▂▇▄▅▃▆▂▅▇▃▄▅▂▆▃▅▄▂▇▅▃  ◄══brush══►          │  context strip
├────────────────────────────────────────────────┤
│  duration ▁▃▅▂▇▄▅▃▆▂▅▇▃    P95 ▁▃▅▂▇▄▅▃▆       │  trend charts
│  AHI      ▂▂▁▃▂▁▂▄▂▁▃▂▂    leak ▃▃▄▃▃▄▃▃▄      │
├────────────────────────────────────────────────┤
│  date  dur  P95  AHI  leak  mode      ▸        │  sortable table
└────────────────────────────────────────────────┘
```

**Empty state:** a large drop target with a short explanation and a click-to-browse fallback.

**Range selection** offers three routes to the same state, because people reach for
different ones: preset buttons (7/30/90/all), a draggable brush on the context strip, and
two date inputs. Filtering is synchronous — with 69 nights a full recompute is
sub-millisecond, so no debouncing.

**Night detail** mirrors the vendor's Play Back layout, which is proven: a tabbed overview
strip (pressure envelope / leak / events) across the full noon-to-noon axis, a histogram
with cumulative distribution and P90/P95 markers beside it, and the waveform below with
30s/60s/2m/5m window presets plus Home/PageUp/PageDown/End. Clicking the overview strip
jumps the waveform to that time.

Sessions are positioned at their real timestamps on the night axis, so a mask-off gap
renders as an actual gap rather than a splice. This works because the first session of a
file starts at the noon epoch.

**Timestamps** are device-RTC and frequently unset — 54 of 69 files in the reference corpus
begin at exactly `12:00:00`. The UI must therefore treat elapsed time within a session as
authoritative and wall-clock time as nominal, and say so where it could mislead.

## Error handling

| Case | Behaviour |
|---|---|
| `.ds3` / `.ds4` dropped | Refused by extension with a clear message. Critical: this parser would produce confident garbage from a `.ds3` |
| Other non-`.ds1` files in a folder | Skipped silently, reported as a count |
| Truncated file | Parse what is valid, flag the night `partial`. Fixed-size self-describing records make resync a scan to the next 4-byte boundary with bit 7 set |
| Samples before any SWITCH record | Synthesise a session at noon from the filename, matching vendor behaviour |
| Empty or zero-session file | Shown as a night with 0 h |
| Very large drops | Warn past ~300 nights (~350 MB projected). No fallback path until someone hits it |

## Testing

The best available oracle is `ds1.py`, which is already validated against the vendor
software. It cannot be used with committed fixtures, because real `.ds1` files are health
data and are excluded by `.gitignore`. Hence two layers:

- **Synthetic fixtures.** A small `.ds1` encoder in the test suite generates buffers
  covering single and multi-session files, a missing OFF marker, trailing sector padding, a
  corrupt region, and parameter variants. Deterministic, no personal data, committable.
- **Opt-in differential test.** An env var points the suite at a real directory; it runs
  `ds1.py --export` and asserts the TypeScript parser reproduces it row-for-row. Never runs
  in CI.

Unit coverage on the pure modules: bit extraction against hand-built buffers; histogram
percentiles against a naive sort; `lowpass` against Python reference values; decimation
invariants (the envelope contains the true extrema, and is the identity when width ≥ sample
count).

Runner: Vitest.

## Distribution

`vite-plugin-singlefile` emits one `dist/index.html`. Build output is not committed. A
GitHub Action builds on tag, attaches `ds-viewer.html` to the release, and publishes Pages.
This is inert until the repository has a remote, so it lands last.

## Open questions

- **The vendor's P90/P95 cannot be reproduced.** Three hypotheses were tested against nine
  reference days and all rejected: raw-sample percentiles, binned-CDF with interpolation
  (floor and round binning), and per-minute / per-5-minute aggregation. All land
  systematically *above* the vendor's figures, as does the per-breath expiratory-minimum
  series. Their distribution has more mass at low pressure than any series derivable from
  the file. Unresolved; does not block v1.
- **Flow scale** (≈0.12 L/min per count) is inferred from the vendor's tidal-volume formula
  and corroborated by expected mask vent flow, not read from a calibration constant.
- **Parameter key `0x12`** has no corresponding constant in the vendor library.
