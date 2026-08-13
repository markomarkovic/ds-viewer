import { useEffect, useState } from 'preact/hooks'
import uPlot from 'uplot'
import { minmaxEnvelope } from '../parse/decimate'
import type { Night } from '../types'
import { FLOW_LPM, HZ } from '../types'
import { axisTheme, Chart } from './Chart'
import { clockLabel, placeSessions } from './nightAxis'

const PRESETS = [
  ['30s', 30],
  ['60s', 60],
  ['2m', 120],
  ['5m', 300],
] as const

type Series = { xs: number[]; lo: (number | null)[]; hi: (number | null)[] }

function windowData(
  night: Night,
  channel: 'press' | 'flow',
  startSec: number,
  windowSec: number,
  width: number
): Series {
  const xs: number[] = []
  const lo: (number | null)[] = []
  const hi: (number | null)[] = []
  const scale = channel === 'press' ? 0.1 : FLOW_LPM
  for (const { session, offsetSec } of placeSessions(night)) {
    const data = session[channel]
    const s0 = Math.max(0, Math.floor((startSec - offsetSec) * HZ))
    const s1 = Math.min(
      data.length,
      Math.ceil((startSec + windowSec - offsetSec) * HZ)
    )
    if (s1 <= s0) continue
    if (xs.length) {
      // null-gap between sessions so uPlot breaks the line
      xs.push(offsetSec + s0 / HZ - 0.001)
      lo.push(null)
      hi.push(null)
    }
    const count = s1 - s0
    const pxBudget = Math.max(
      16,
      Math.floor((width * (count / HZ)) / windowSec)
    )
    const env = minmaxEnvelope(data, s0, s1, pxBudget)
    const step = count / env.min.length
    for (let i = 0; i < env.min.length; i++) {
      xs.push(offsetSec + (s0 + i * step + step / 2) / HZ)
      lo.push(env.min[i]! * scale)
      hi.push(env.max[i]! * scale)
    }
  }
  return { xs, lo, hi }
}

export function Waveform({
  night,
  jumpSec,
}: {
  night: Night
  jumpSec: number | null
}) {
  const placed = placeSessions(night)
  const firstStart = placed[0]?.offsetSec ?? 0
  const lastEnd = placed.length
    ? placed[placed.length - 1]!.offsetSec +
      placed[placed.length - 1]!.session.press.length / HZ
    : 0
  const [view, setView] = useState({ startSec: firstStart, windowSec: 300 })

  useEffect(() => {
    if (jumpSec !== null)
      setView((v) => ({ ...v, startSec: jumpSec - v.windowSec / 2 }))
  }, [jumpSec])

  const clampStart = (s: number, w: number) =>
    Math.min(Math.max(s, firstStart), Math.max(firstStart, lastEnd - w))
  const page = (dir: -1 | 1) =>
    setView((v) => ({
      ...v,
      startSec: clampStart(v.startSec + dir * v.windowSec, v.windowSec),
    }))

  const apneas = placed.flatMap(({ session, offsetSec }) =>
    session.events
      .filter((e) => e.kind === 'APNEA')
      .map((e) => offsetSec + e.index / HZ)
  )

  return (
    <section>
      <div class="toolbar">
        <div role="group">
          {PRESETS.map(([label, sec]) => (
            <button
              key={label}
              class={view.windowSec === sec ? '' : 'outline'}
              onClick={() =>
                setView((v) => ({
                  windowSec: sec,
                  startSec: clampStart(v.startSec, sec),
                }))
              }
            >
              {label}
            </button>
          ))}
          <button
            class="outline"
            onClick={() => setView({ startSec: firstStart, windowSec: 300 })}
          >
            Home
          </button>
          <button class="outline" onClick={() => page(-1)}>
            ◀ Page
          </button>
          <button class="outline" onClick={() => page(1)}>
            Page ▶
          </button>
          <button
            class="outline"
            onClick={() =>
              setView((v) => ({
                ...v,
                startSec: clampStart(lastEnd - v.windowSec, v.windowSec),
              }))
            }
          >
            End
          </button>
        </div>
        <small class="range-label">
          {clockLabel(view.startSec)} –{' '}
          {clockLabel(view.startSec + view.windowSec)}
        </small>
      </div>
      <Chart
        deps={[night.name, view.startSec, view.windowSec]}
        build={(el, width) => {
          const p = windowData(
            night,
            'press',
            view.startSec,
            view.windowSec,
            width
          )
          const f = windowData(
            night,
            'flow',
            view.startSec,
            view.windowSec,
            width
          )
          return new uPlot(
            {
              width,
              height: 320,
              scales: {
                x: {
                  time: false,
                  range: [view.startSec, view.startSec + view.windowSec],
                },
                p: { range: (_u, _min, max) => [0, Math.max(10, max * 1.1)] },
                f: { range: (_u, _min, max) => [0, Math.max(30, max * 1.1)] },
              },
              series: [
                {},
                { label: 'press lo', scale: 'p', stroke: '#3a7ca5' },
                { label: 'press hi', scale: 'p', stroke: '#3a7ca5' },
                { label: 'flow lo', scale: 'f', stroke: '#4c9a52' },
                { label: 'flow hi', scale: 'f', stroke: '#4c9a52' },
              ],
              bands: [
                { series: [2, 1], fill: '#3a7ca544' },
                { series: [4, 3], fill: '#4c9a5233' },
              ],
              axes: [
                {
                  ...axisTheme(),
                  values: (_u, splits) => splits.map(clockLabel),
                },
                { ...axisTheme(), scale: 'p', label: 'pressure cmH2O' },
                { ...axisTheme(), scale: 'f', label: 'flow L/min', side: 1 },
              ],
              legend: { show: false },
              cursor: { drag: { x: false, y: false } },
              hooks: {
                draw: [
                  (u) => {
                    const ctx = u.ctx
                    ctx.save()
                    ctx.strokeStyle = '#c33'
                    ctx.fillStyle = '#c33'
                    for (const sec of apneas) {
                      if (
                        sec < view.startSec ||
                        sec > view.startSec + view.windowSec
                      )
                        continue
                      const x = u.valToPos(sec, 'x', true)
                      ctx.setLineDash([2, 3])
                      ctx.beginPath()
                      ctx.moveTo(x, u.bbox.top)
                      ctx.lineTo(x, u.bbox.top + u.bbox.height)
                      ctx.stroke()
                      ctx.setLineDash([])
                      ctx.beginPath()
                      ctx.moveTo(x - 4, u.bbox.top + 10)
                      ctx.lineTo(x + 4, u.bbox.top + 10)
                      ctx.lineTo(x, u.bbox.top + 2)
                      ctx.closePath()
                      ctx.fill()
                    }
                    ctx.restore()
                  },
                ],
              },
            },
            // xs must be a plain aligned array; lo/hi pairs per channel
            [p.xs, p.lo, p.hi, f.lo, f.hi] as uPlot.AlignedData,
            el
          )
        }}
      />
    </section>
  )
}
