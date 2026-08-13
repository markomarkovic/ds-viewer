import { useState } from 'preact/hooks'
import uPlot from 'uplot'
import type { EventKind, Night } from '../types'
import { cmH2O, deci, PARAM, WORKMODE } from '../types'
import { axisTheme, Chart, nightCursorSync, tooltipPlugin } from './Chart'
import { Histogram } from './Histogram'
import { clockLabel, nightGrid, placeSessions } from './nightAxis'
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
  const [jumpSec, setJumpSec] = useState<number | null>(null)
  return (
    <section>
      <OverviewStrip night={night} channel="pressure" onJump={setJumpSec} />
      <OverviewStrip night={night} channel="leak" onJump={setJumpSec} />
      <EventChart night={night} onJump={setJumpSec} />
      <Waveform night={night} jumpSec={jumpSec} />
      <Histogram night={night} />
    </section>
  )
}

function OverviewStrip({
  night,
  channel,
  onJump,
}: {
  night: Night
  channel: 'pressure' | 'leak'
  onJump: (sec: number) => void
}) {
  const ch = channel === 'pressure' ? 'press' : 'leak'
  const g = nightGrid(night, 1024, ch)
  const scale = channel === 'pressure' ? 0.1 : 1 // press stored in deci
  const min = Array.from(g.min, (v) => (Number.isNaN(v) ? null : v * scale))
  const max = Array.from(g.max, (v) => (Number.isNaN(v) ? null : v * scale))
  const unit = channel === 'pressure' ? 'cmH2O' : 'L/min'
  return (
    <Chart
      deps={[night.name, channel]}
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
            cursor: {
              y: false,
              drag: { x: false, y: false },
              sync: nightCursorSync,
            },
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
              ready: [
                (u) => {
                  u.over.addEventListener('click', (e) => {
                    const rect = u.over.getBoundingClientRect()
                    onJump(u.posToVal(e.clientX - rect.left, 'x'))
                  })
                },
              ],
            },
          },
          [Array.from(g.xs), min, max],
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

/**
 * Device-flagged events as a uPlot chart, so it shares the night cursor
 * sync and axis geometry with the strips above and the waveform below.
 * The marks are painted in a draw hook; an invisible series carries the
 * event times so the tooltip can name the nearest mark.
 */
function EventChart({
  night,
  onJump,
}: {
  night: Night
  onJump: (sec: number) => void
}) {
  const events: Array<{
    sec: number
    row: number
    label: string
    color: string
  }> = []
  for (const { session, offsetSec } of placeSessions(night)) {
    for (const e of session.events) {
      const lane = LANES.find((l) => l.kind === e.kind)
      if (!lane) continue
      events.push({
        sec: offsetSec + e.index / 10,
        row: lane.row,
        label: lane.label,
        color: lane.color,
      })
    }
  }
  events.sort((a, b) => a.sec - b.sec)
  const xs = events.map((e) => e.sec)
  const ys = events.map((e) => e.row + 0.5)
  const data: uPlot.AlignedData = xs.length ? [xs, ys] : [[0], [null]]
  const counts = night.events
  return (
    <div>
      <Chart
        deps={[night.name]}
        build={(el, width) =>
          new uPlot(
            {
              title: 'events (device-flagged)',
              width,
              height: 140,
              scales: {
                x: { time: false, range: [0, 86400] },
                y: { range: [0, 3] },
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
                  size: 56,
                  splits: () => LANES.map((l) => l.row + 0.5),
                  values: () => [...LANES].reverse().map((l) => l.label),
                  grid: { show: false },
                },
              ],
              legend: { show: false },
              cursor: {
                y: false,
                drag: { x: false, y: false },
                sync: nightCursorSync,
              },
              plugins: [
                tooltipPlugin((u, i) => {
                  const ev = events[i]
                  if (!ev) return null
                  // only name a mark when the cursor is actually near it
                  const px = u.valToPos(ev.sec, 'x')
                  const left = u.cursor.left
                  if (left == null || Math.abs(px - left) > 24) return null
                  return `${clockLabel(ev.sec)}\n${ev.label}`
                }),
              ],
              hooks: {
                ready: [
                  (u) => {
                    u.over.addEventListener('click', (e) => {
                      const rect = u.over.getBoundingClientRect()
                      onJump(u.posToVal(e.clientX - rect.left, 'x'))
                    })
                  },
                ],
                draw: [
                  (u) => {
                    const ctx = u.ctx
                    ctx.save()
                    const dpr = devicePixelRatio
                    for (const ev of events) {
                      const x = u.valToPos(ev.sec, 'x', true)
                      const y0 = u.valToPos(ev.row + 0.1, 'y', true)
                      const y1 = u.valToPos(ev.row + 0.9, 'y', true)
                      ctx.fillStyle = ev.color
                      ctx.fillRect(
                        x - dpr,
                        Math.min(y0, y1),
                        2 * dpr,
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
        {counts.apnea} apnea · {counts.pressUp} press-up · {counts.pressDown}{' '}
        press-down
      </small>
    </div>
  )
}
