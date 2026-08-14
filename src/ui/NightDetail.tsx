import { useEffect, useMemo, useState } from 'preact/hooks'
import uPlot from 'uplot'
import type { EventKind, Night, ScoredKind } from '../types'
import { cmH2O, deci, PARAM, WORKMODE } from '../types'
import { axisTheme, Chart, nightCursorSync, tooltipPlugin } from './Chart'
import { Estimated } from './Estimated'
import { Histogram } from './Histogram'
import type { NightView } from './nightAxis'
import {
  clockLabel,
  nightBounds,
  nightGrid,
  placeSessions,
  scoredSpanSec,
} from './nightAxis'
import { Waveform } from './Waveform'

/** Header-bar content for the detail page; App renders it in <header>. */
export function NightHeader({
  night,
  onBack,
}: {
  night: Night
  onBack: () => void
}) {
  const first = night.sessions[0]
  const mode = first?.params.get(PARAM.WorkMode)
  const minP = first?.params.get(PARAM.MinPress)
  const maxP = first?.params.get(PARAM.MaxPress)
  return (
    <nav>
      <ul>
        <li>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              onBack()
            }}
          >
            ← all nights
          </a>
        </li>
        <li>
          <hgroup>
            <h3>{night.date.toLocaleDateString()}</h3>
            <p>
              {mode !== undefined ? (WORKMODE[mode] ?? mode) : ''}{' '}
              {minP !== undefined && maxP !== undefined
                ? `${cmH2O(deci(minP)).toFixed(0)}–${cmH2O(deci(maxP)).toFixed(0)} cmH2O`
                : ''}{' '}
              · {night.sessions.length} session(s)
              {night.partial ? ' · ⚠ file truncated' : ''}
            </p>
          </hgroup>
        </li>
      </ul>
    </nav>
  )
}

export function NightDetail({ night }: { night: Night }) {
  const { firstStart, lastEnd } = nightBounds(night)
  const [view, setView] = useState<NightView>({
    startSec: firstStart,
    windowSec: 300,
  })
  useEffect(() => {
    setView({ startSec: nightBounds(night).firstStart, windowSec: 300 })
  }, [night])

  const clampStart = (s: number, w: number) =>
    Math.min(Math.max(s, firstStart), Math.max(firstStart, lastEnd - w))
  const setWindow = (fromSec: number, toSec: number) => {
    const w = Math.max(10, toSec - fromSec)
    setView({ startSec: clampStart(fromSec, w), windowSec: w })
  }
  const centerAt = (sec: number) =>
    setView((v) => ({
      ...v,
      startSec: clampStart(sec - v.windowSec / 2, v.windowSec),
    }))

  const strip = { view, onWindow: setWindow, onCenter: centerAt }
  return (
    <section class="night">
      <OverviewStrip night={night} channel="pressure" {...strip} />
      <OverviewStrip night={night} channel="leak" {...strip} />
      <EventChart night={night} {...strip} />
      <Waveform
        night={night}
        view={view}
        onView={setView}
        onWindow={setWindow}
      />
      <Histogram night={night} />
      <BreathStats night={night} />
    </section>
  )
}

function BreathStats({ night }: { night: Night }) {
  const b = night.breath
  if (!b) return null
  const f1 = (n: number) => n.toFixed(1)
  const rows: Array<[string, string, string, string, string]> = [
    [
      'tidal volume (mL)',
      `${b.tv.avg}`,
      `${b.tv.p50}`,
      `${b.tv.p90}`,
      `${b.tv.p95}`,
    ],
    [
      'breath rate (BPM)',
      f1(b.bpm.avg),
      f1(b.bpm.p50),
      f1(b.bpm.p90),
      f1(b.bpm.p95),
    ],
    [
      'inspiration : expiration ratio (I:E)',
      `1:${f1(b.ie.avg)}`,
      `1:${f1(b.ie.p50)}`,
      `1:${f1(b.ie.p90)}`,
      `1:${f1(b.ie.p95)}`,
    ],
    [
      'minute ventilation (mL/min)',
      `${b.mv.avg}`,
      `${b.mv.p50}`,
      `${b.mv.p90}`,
      `${b.mv.p95}`,
    ],
    [
      'leakage (L/min)',
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
            <th>avg</th>
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
                <td key={i}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Brush behaviour shared by the night strips: drag selects the waveform
 * window, the active window stays painted as a selection, and a plain
 * click centres the window. Programmatic setSelect calls pass fire=false,
 * so only real drags reach the setSelect hook.
 */
function stripCursorOpts(
  view: NightView,
  onWindow: (fromSec: number, toSec: number) => void,
  onCenter: (sec: number) => void
): {
  cursor: uPlot.Cursor
  showView: (u: uPlot) => void
  ready: (u: uPlot) => void
  setSelect: (u: uPlot) => void
} {
  let dragged = false
  const showView = (u: uPlot) => {
    const left = u.valToPos(view.startSec, 'x')
    const w = u.valToPos(view.startSec + view.windowSec, 'x') - left
    u.setSelect(
      { left, width: Math.max(w, 1), top: 0, height: u.over.clientHeight },
      false
    )
  }
  return {
    cursor: {
      y: false,
      drag: { x: true, y: false, setScale: false },
      sync: nightCursorSync,
    },
    showView,
    ready: (u) => {
      showView(u)
      u.over.addEventListener('click', (e) => {
        if (dragged) {
          dragged = false
          return
        }
        const rect = u.over.getBoundingClientRect()
        onCenter(u.posToVal(e.clientX - rect.left, 'x'))
      })
    },
    setSelect: (u) => {
      if (u.select.width < 2) {
        showView(u)
        return
      }
      dragged = true
      onWindow(
        u.posToVal(u.select.left, 'x'),
        u.posToVal(u.select.left + u.select.width, 'x')
      )
    },
  }
}

function OverviewStrip({
  night,
  channel,
  view,
  onWindow,
  onCenter,
}: {
  night: Night
  channel: 'pressure' | 'leak'
  view: NightView
  onWindow: (fromSec: number, toSec: number) => void
  onCenter: (sec: number) => void
}) {
  const ch = channel === 'pressure' ? 'press' : 'leak'
  const scale = channel === 'pressure' ? 0.1 : 1 // press stored in deci
  const { min, max, xs } = useMemo(() => {
    const g = nightGrid(night, 1024, ch)
    return {
      xs: Array.from(g.xs),
      min: Array.from(g.min, (v) => (Number.isNaN(v) ? null : v * scale)),
      max: Array.from(g.max, (v) => (Number.isNaN(v) ? null : v * scale)),
    }
  }, [night, ch, scale])
  const unit = channel === 'pressure' ? 'cmH2O' : 'L/min'
  const brush = stripCursorOpts(view, onWindow, onCenter)
  return (
    <Chart
      deps={[night.name, channel, view.startSec, view.windowSec]}
      build={(el, width) =>
        new uPlot(
          {
            title: channel,
            width,
            height: 160,
            scales: { x: { time: false } },
            series: [
              {},
              { label: 'min', stroke: '#3a7ca5' },
              { label: 'max', stroke: '#3a7ca5' },
            ],
            bands: [{ series: [2, 1], fill: '#3a7ca544' }],
            axes: [
              {
                ...axisTheme(),
                values: (_u, splits) => splits.map(clockLabel),
              },
              { ...axisTheme(), label: unit, size: 56 },
            ],
            legend: { show: false },
            cursor: brush.cursor,
            plugins: [
              tooltipPlugin((u, i) => {
                const x = u.data[0][i]
                const lo = u.data[1]?.[i]
                const hi = u.data[2]?.[i]
                if (x == null || lo == null || hi == null) return null
                return `${clockLabel(x)}\n${lo.toFixed(1)}–${hi.toFixed(1)} ${unit}`
              }),
            ],
            hooks: {
              ready: [brush.ready],
              setSelect: [brush.setSelect],
            },
          },
          [xs, min, max],
          el
        )
      }
    />
  )
}

const LANES: Array<{
  kind: EventKind
  label: string
  color: string
  row: number
}> = [
  { kind: 'APNEA', label: 'apnea', color: '#c33', row: 2 },
  { kind: 'PRESS_UP', label: 'press up', color: '#3a7ca5', row: 1 },
  { kind: 'PRESS_DOWN', label: 'press down', color: '#8a6d3b', row: 0 },
]

// device apnea shares LANES' row/kind but gets a dimmer color and a
// "(device)" label once scored spans are on the same chart, to keep it
// visually distinct from the scored OSA lane below.
const DEVICE_LANES_SCORED: typeof LANES = LANES.map((l) =>
  l.kind === 'APNEA' ? { ...l, label: 'apnea (device)', color: '#c3333388' } : l
)

const SCORED_LANES: Array<{
  kind: ScoredKind
  label: string
  color: string
  row: number
}> = [
  { kind: 'OSA', label: 'OSA', color: '#c33', row: 5 },
  { kind: 'CSA', label: 'CSA', color: '#8338ec', row: 4 },
  { kind: 'HYP', label: 'hypopnea', color: '#e8a33d', row: 3 },
]

/**
 * Device-flagged events (and, once scoring has run, the scored OSA/CSA/
 * hypopnea spans above them) as a uPlot chart, so it shares the night
 * cursor sync and axis geometry with the strips above and the waveform
 * below. Marks and spans are painted in a draw hook; an invisible series
 * carries their times so the tooltip can name the nearest one.
 */
function EventChart({
  night,
  view,
  onWindow,
  onCenter,
}: {
  night: Night
  view: NightView
  onWindow: (fromSec: number, toSec: number) => void
  onCenter: (sec: number) => void
}) {
  const brush = stripCursorOpts(view, onWindow, onCenter)
  const scored = night.scored
  const deviceLanes = scored !== null ? DEVICE_LANES_SCORED : LANES
  const laneList = scored !== null ? [...SCORED_LANES, ...deviceLanes] : LANES

  const ticks: Array<{
    sec: number
    row: number
    label: string
    color: string
  }> = []
  for (const { session, offsetSec } of placeSessions(night)) {
    for (const e of session.events) {
      const lane = deviceLanes.find((l) => l.kind === e.kind)
      if (!lane) continue
      ticks.push({
        sec: offsetSec + e.index / 10,
        row: lane.row,
        label: lane.label,
        color: lane.color,
      })
    }
  }

  const spans = (scored ?? []).map((e) => {
    const lane = SCORED_LANES.find((l) => l.kind === e.kind)!
    const { from: startSec, to: endSec } = scoredSpanSec(night, e)
    return {
      row: lane.row,
      label: lane.label,
      color: lane.color,
      startSec,
      endSec,
      midSec: (startSec + endSec) / 2,
      durSec: e.len / 10,
      kind: e.kind,
    }
  })

  const events: Array<{
    sec: number
    row: number
    label: string
    color: string
    durSec?: number
    kind?: ScoredKind
  }> = [
    ...ticks,
    ...spans.map((s) => ({
      sec: s.midSec,
      row: s.row,
      label: s.label,
      color: s.color,
      durSec: s.durSec,
      kind: s.kind,
    })),
  ]
  events.sort((a, b) => a.sec - b.sec)
  const xs = events.map((e) => e.sec)
  const ys = events.map((e) => e.row + 0.5)
  const data: uPlot.AlignedData = xs.length ? [xs, ys] : [[0], [null]]
  const counts = night.events

  return (
    <div>
      <Chart
        deps={[night.name, view.startSec, view.windowSec]}
        build={(el, width) =>
          new uPlot(
            {
              title:
                scored !== null
                  ? 'events — scored (estimated) · device-flagged'
                  : 'events (device-flagged)',
              width,
              height: scored !== null ? 200 : 140,
              scales: {
                x: { time: false, range: [0, 86400] },
                y: { range: scored !== null ? [0, 6] : [0, 3] },
              },
              series: [
                {},
                {
                  scale: 'y',
                  paths: () => null,
                  points: { show: false },
                },
              ],
              axes: [
                {
                  ...axisTheme(),
                  values: (_u, splits) => splits.map(clockLabel),
                },
                {
                  ...axisTheme(),
                  scale: 'y',
                  size: scored !== null ? 100 : 56,
                  splits: () => laneList.map((l) => l.row + 0.5),
                  // splits and labels are both drawn from laneList in the
                  // same order, so label i always names split i's row.
                  values: () => laneList.map((l) => l.label),
                  grid: { show: false },
                },
              ],
              legend: { show: false },
              cursor: brush.cursor,
              plugins: [
                tooltipPlugin((u, i) => {
                  const ev = events[i]
                  if (!ev) return null
                  // only name a mark when the cursor is actually near it
                  const px = u.valToPos(ev.sec, 'x')
                  const left = u.cursor.left
                  if (left == null || Math.abs(px - left) > 24) return null
                  if (ev.durSec === undefined)
                    return `${clockLabel(ev.sec)}\n${ev.label}`
                  const kindLabel = ev.kind === 'HYP' ? 'hypopnea' : ev.kind
                  return `${clockLabel(ev.sec)}\n${kindLabel}: ${ev.durSec.toFixed(1)}s`
                }),
              ],
              hooks: {
                ready: [brush.ready],
                setSelect: [brush.setSelect],
                draw: [
                  (u) => {
                    const ctx = u.ctx
                    ctx.save()
                    const dpr = devicePixelRatio
                    for (const t of ticks) {
                      const x = u.valToPos(t.sec, 'x', true)
                      const y0 = u.valToPos(t.row + 0.1, 'y', true)
                      const y1 = u.valToPos(t.row + 0.9, 'y', true)
                      ctx.fillStyle = t.color
                      ctx.fillRect(
                        x - dpr,
                        Math.min(y0, y1),
                        2 * dpr,
                        Math.abs(y0 - y1)
                      )
                    }
                    for (const s of spans) {
                      const x0 = u.valToPos(s.startSec, 'x', true)
                      const x1 = u.valToPos(s.endSec, 'x', true)
                      const y0 = u.valToPos(s.row + 0.1, 'y', true)
                      const y1 = u.valToPos(s.row + 0.9, 'y', true)
                      ctx.fillStyle = s.color
                      ctx.fillRect(
                        x0,
                        Math.min(y0, y1),
                        Math.max(x1 - x0, 2 * dpr),
                        Math.abs(y0 - y1)
                      )
                    }
                    ctx.restore()
                  },
                ],
              },
            },
            data,
            el
          )
        }
      />
      <small>
        {scored !== null ? (
          <>
            {scored.filter((e) => e.kind === 'OSA').length} OSA ·{' '}
            {scored.filter((e) => e.kind === 'CSA').length} CSA ·{' '}
            {scored.filter((e) => e.kind === 'HYP').length} hypopnea (scored) ·{' '}
            {counts.apnea} apnea (device) · {counts.pressUp} press-up ·{' '}
            {counts.pressDown} press-down
          </>
        ) : (
          <>
            {counts.apnea} apnea · {counts.pressUp} press-up ·{' '}
            {counts.pressDown} press-down
          </>
        )}
      </small>
    </div>
  )
}
