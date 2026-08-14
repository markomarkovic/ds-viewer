import uPlot from 'uplot'
import type { Night } from '../types'
import { cmH2O } from '../types'
import { axisTheme, Chart, tooltipPlugin } from './Chart'

export function Histogram({ night }: { night: Night }) {
  // aggregate 0.1-bins into 0.5 cmH2O columns; % of time + cumulative %
  const bins = 60
  const xs: number[] = []
  const pct: number[] = []
  const cum: number[] = []
  let running = 0
  for (let b = 0; b < bins; b++) {
    let c = 0
    for (let i = b * 5; i < b * 5 + 5 && i < 301; i++) c += night.histogram[i]!
    running += c
    xs.push(b * 0.5 + 0.25)
    pct.push(night.samples ? (c / night.samples) * 100 : 0)
    cum.push(night.samples ? (running / night.samples) * 100 : 0)
  }
  const p90 = cmH2O(night.press.p90)
  const p95 = cmH2O(night.press.p95)
  return (
    <div>
      {/* uPlot's own title class, so it matches the other charts exactly */}
      <div class="u-title">
        time in pressure — P90 {p90.toFixed(1)} · P95 {p95.toFixed(1)} cmH2O{' '}
        <span
          class="info-tip"
          data-tooltip="Time-weighted percentiles of the raw pressure samples (channel-exact). The Horizontal Pressure P90/P95 in the summary reproduce the vendor's breath-based figures."
          data-placement="left"
        >
          ⓘ
        </span>
      </div>
      <Chart
        deps={[night.name]}
        build={(el, width) =>
          new uPlot(
            {
              width,
              height: 180,
              scales: { x: { time: false }, '%': { range: [0, 102] } },
              series: [
                {},
                {
                  label: '% time',
                  scale: '%',
                  stroke: '#3a7ca5',
                  fill: '#3a7ca555',
                  paths: uPlot.paths.bars!({ size: [0.9, 100] }),
                  points: { show: false },
                },
                { label: 'cumulative', scale: '%', stroke: '#e8a33d' },
              ],
              axes: [
                { ...axisTheme(), label: 'cmH2O' },
                { ...axisTheme(), scale: '%', label: '%' },
              ],
              legend: { show: false },
              cursor: { y: false, drag: { x: false, y: false } },
              plugins: [
                tooltipPlugin((u, i) => {
                  const x = u.data[0][i]
                  const p = u.data[1]?.[i]
                  const c = u.data[2]?.[i]
                  if (x == null || p == null || c == null) return null
                  return `${(x - 0.25).toFixed(1)}–${(x + 0.25).toFixed(1)} cmH2O\n${p.toFixed(1)}% of night · ${c.toFixed(0)}% below`
                }),
              ],
              hooks: {
                draw: [
                  (u) => {
                    const ctx = u.ctx
                    ctx.save()
                    for (const [v, color] of [
                      [p90, '#2c7a2c'],
                      [p95, '#c33'],
                    ] as const) {
                      const x = u.valToPos(v, 'x', true)
                      ctx.strokeStyle = color
                      ctx.setLineDash([4, 4])
                      ctx.beginPath()
                      ctx.moveTo(x, u.bbox.top)
                      ctx.lineTo(x, u.bbox.top + u.bbox.height)
                      ctx.stroke()
                    }
                    ctx.restore()
                  },
                ],
              },
            },
            [xs, pct, cum],
            el
          )
        }
      />
    </div>
  )
}
