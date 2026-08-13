import uPlot from 'uplot'
import type { DateRange } from '../state'
import type { Night } from '../types'
import { Chart } from './Chart'

const DAY = 86400_000

export function RangeSelector({
  nights,
  range,
  onRange,
}: {
  nights: Night[]
  range: DateRange
  onRange: (r: DateRange) => void
}) {
  const asc = [...nights].sort((a, b) => a.date.getTime() - b.date.getTime())
  const last = asc[asc.length - 1]
  const preset = (days: number | null) => {
    if (days === null || !last) return onRange({ from: null, to: null })
    onRange({ from: last.date.getTime() - days * DAY, to: null })
  }
  const toInput = (ms: number | null) =>
    ms === null ? '' : new Date(ms).toISOString().slice(0, 10)
  const fromInput = (v: string) => (v ? new Date(v).getTime() : null)
  const xs = asc.map((n) => n.date.getTime() / 1000)
  const ys = asc.map((n) => n.hours)
  return (
    <section>
      <div role="group">
        <button class="outline" onClick={() => preset(7)}>
          7d
        </button>
        <button class="outline" onClick={() => preset(30)}>
          30d
        </button>
        <button class="outline" onClick={() => preset(90)}>
          90d
        </button>
        <button class="outline" onClick={() => preset(null)}>
          all
        </button>
        <input
          type="date"
          value={toInput(range.from)}
          onChange={(e) =>
            onRange({
              ...range,
              from: fromInput((e.currentTarget as HTMLInputElement).value),
            })
          }
        />
        <input
          type="date"
          value={toInput(range.to)}
          onChange={(e) =>
            onRange({
              ...range,
              to: fromInput((e.currentTarget as HTMLInputElement).value),
            })
          }
        />
      </div>
      <Chart
        deps={[nights]}
        build={(el, width) =>
          new uPlot(
            {
              width,
              height: 64,
              scales: { x: { time: true } },
              series: [
                {},
                {
                  stroke: 'gray',
                  fill: '#8884',
                  paths: uPlot.paths.bars!({ size: [0.7, 86400] }),
                  points: { show: false },
                },
              ],
              axes: [{ size: 24 }, { show: false }],
              legend: { show: false },
              cursor: { drag: { x: true, y: false, setScale: false } },
              hooks: {
                setSelect: [
                  (u) => {
                    if (u.select.width < 2) return
                    const from = u.posToVal(u.select.left, 'x') * 1000
                    const to =
                      u.posToVal(u.select.left + u.select.width, 'x') * 1000
                    onRange({ from, to })
                    u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false)
                  },
                ],
              },
            },
            [xs, ys],
            el
          )
        }
      />
    </section>
  )
}
