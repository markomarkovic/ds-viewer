import uPlot from 'uplot'
import type { Night } from '../types'
import { axisTheme, Chart, dateCursorSync, tooltipPlugin } from './Chart'

export function TrendChart({
  title,
  nights,
  value,
  color,
}: {
  title: string
  nights: Night[]
  value: (n: Night) => number
  color: string
}) {
  const asc = [...nights].sort((a, b) => a.date.getTime() - b.date.getTime())
  const xs = asc.map((n) => n.date.getTime() / 1000)
  const ys = asc.map(value)
  return (
    <Chart
      deps={[nights, title]}
      build={(el, width) =>
        new uPlot(
          {
            title,
            width,
            height: 140,
            scales: { x: { time: true } },
            series: [
              {},
              {
                label: title,
                stroke: color,
                fill: color + '55',
                paths: uPlot.paths.bars!({ size: [0.7, 86400] }),
                points: { show: false },
              },
            ],
            axes: [axisTheme(), { ...axisTheme(), size: 44 }],
            legend: { show: false },
            cursor: {
              y: false,
              drag: { x: false, y: false },
              sync: dateCursorSync,
            },
            plugins: [
              tooltipPlugin((u, i) => {
                const x = u.data[0][i]
                const y = u.data[1]?.[i]
                if (x == null || y == null) return null
                const day = new Date(x * 1000).toLocaleDateString()
                return `${day}\n${title}: ${y.toFixed(1)}`
              }),
            ],
          },
          [xs, ys],
          el
        )
      }
    />
  )
}
