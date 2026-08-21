import uPlot from 'uplot'
import type { Night } from '../types'
import {
  axisTheme,
  Chart,
  dateCursorSync,
  localDateValues,
  tooltipPlugin,
} from './Chart'

const SCORED_COLOR = '#a54c3a'
const DEVICE_COLOR = '#d99a8b'

const APNEA_TIP =
  'Apneas per night, side by side: the scored count (obstructive plus ' +
  "central, detected by this viewer using the vendor's own flow-channel " +
  "scoring) next to the device's own APNEA records. They are two " +
  "independent counts of the same night; the vendor's app ignores the " +
  "device's stored records and scores from the flow channel, as this " +
  'viewer does.'

const scoredApneas = (n: Night) =>
  n.scored ? n.scored.filter((e) => e.kind !== 'HYP').length : 0

export function ApneaChart({ nights }: { nights: Night[] }) {
  const asc = [...nights].sort((a, b) => a.date.getTime() - b.date.getTime())
  const xs = asc.map((n) => n.date.getTime() / 1000)
  const scored = asc.map(scoredApneas)
  const device = asc.map((n) => n.events.apnea)
  return (
    <div>
      <div class="u-title">
        apneas — scored · device-flagged{' '}
        <span class="info-tip" data-tooltip={APNEA_TIP} data-placement="bottom">
          ⓘ
        </span>
      </div>
      <Chart
        deps={[nights]}
        build={(el, width) =>
          new uPlot(
            {
              width,
              height: 140,
              scales: { x: { time: true } },
              series: [
                {},
                {
                  label: 'scored',
                  stroke: SCORED_COLOR,
                  fill: SCORED_COLOR + '55',
                  // align -1 ends the bar at the day tick, 1 starts it
                  // there, so the pair straddles it without overlapping
                  paths: uPlot.paths.bars!({ size: [0.35, 86400], align: -1 }),
                  points: { show: false },
                },
                {
                  label: 'device',
                  stroke: DEVICE_COLOR,
                  fill: DEVICE_COLOR + '55',
                  paths: uPlot.paths.bars!({ size: [0.35, 86400], align: 1 }),
                  points: { show: false },
                },
              ],
              axes: [
                { ...axisTheme(), values: localDateValues },
                { ...axisTheme(), size: 44 },
              ],
              legend: { show: false },
              cursor: {
                y: false,
                drag: { x: false, y: false },
                sync: dateCursorSync,
              },
              plugins: [
                tooltipPlugin((u, i) => {
                  const x = u.data[0][i]
                  const s = scored[i]
                  const d = device[i]
                  if (x == null || s == null || d == null) return null
                  const day = new Date(x * 1000).toLocaleDateString()
                  return `${day}\nscored: ${s} · device: ${d}`
                }),
              ],
            },
            [xs, scored, device],
            el
          )
        }
      />
    </div>
  )
}
