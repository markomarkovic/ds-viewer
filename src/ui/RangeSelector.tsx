import uPlot from 'uplot'
import type { DateRange } from '../state'
import type { Night } from '../types'
import { axisTheme, Chart, dateCursorSync } from './Chart'

const DAY = 86400_000

export function msToDateInput(ms: number | null): string {
  if (ms === null) return ''
  const d = new Date(ms)
  const y = String(d.getFullYear()).padStart(4, '0')
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function dateInputToMs(v: string, edge: 'from' | 'to'): number | null {
  if (!v) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  return edge === 'from'
    ? new Date(y, mo - 1, d).getTime()
    : new Date(y, mo - 1, d, 23, 59, 59, 999).getTime()
}

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
          value={msToDateInput(range.from)}
          onChange={(e) =>
            onRange({
              ...range,
              from: dateInputToMs(
                (e.currentTarget as HTMLInputElement).value,
                'from'
              ),
            })
          }
        />
        <input
          type="date"
          value={msToDateInput(range.to)}
          onChange={(e) =>
            onRange({
              ...range,
              to: dateInputToMs(
                (e.currentTarget as HTMLInputElement).value,
                'to'
              ),
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
              axes: [{ ...axisTheme(), size: 24 }, { show: false }],
              legend: { show: false },
              cursor: {
                y: false,
                drag: { x: true, y: false, setScale: false },
                sync: dateCursorSync,
              },
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
