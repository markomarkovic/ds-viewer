import type { Night } from '../types'
import { kpis } from '../state'

const AHI_TIP =
  'The Apnea-Hypopnea Index (AHI) is the average number of breathing ' +
  'pauses per hour of sleep. Under 5 is normal, 5 to 14 mild, 15 to 29 ' +
  'moderate, 30 or more severe. This figure is estimated by this viewer ' +
  "using the vendor's own scoring: obstructive and central apneas " +
  'detected from the flow channel, per hour of mask-on time. Hypopneas ' +
  'are detected and shown on the night page but, matching the vendor, ' +
  'not counted into the AHI. Nights without enough data fall back to ' +
  "the device's own apnea flags."

export function Summary({ nights }: { nights: Night[] }) {
  const k = kpis(nights)
  const HP_TIP =
    'Horizontal Pressure P90/P95, estimated by this viewer using the ' +
    "vendor's own method: a histogram of the smoothed pressure channel " +
    "over the whole night, matching the vendor's reports on the " +
    'validation corpus. Channel-exact sample-stream avg P95: ' +
    `${k.avgP95.toFixed(1)} cmH2O.`
  const kpi = (label: string, value: string, tip?: string) => (
    <div style="text-align:center">
      <h4 style="margin-bottom:0">{value}</h4>
      <small>
        {label}
        {tip && (
          <>
            {' '}
            <span class="info-tip" data-tooltip={tip} data-placement="bottom">
              ⓘ
            </span>
          </>
        )}
      </small>
    </div>
  )
  return (
    <section style="display:grid; grid-template-columns:repeat(5,1fr); gap:1rem">
      {kpi('nights', String(k.count))}
      {kpi('avg duration', `${k.avgHours.toFixed(1)} h`)}
      {k.avgHp90 !== null && k.avgHp95 !== null ? (
        <div style="text-align:center">
          <h4 style="margin-bottom:0">
            {k.avgHp90.toFixed(1)} / {k.avgHp95.toFixed(1)}
          </h4>
          <small>
            HP P90/P95{' '}
            <span
              class="info-tip"
              data-tooltip={HP_TIP}
              data-placement="bottom"
            >
              ⓘ
            </span>
          </small>
        </div>
      ) : (
        kpi('avg P95', `${k.avgP95.toFixed(1)} cmH2O`)
      )}
      {kpi('avg AHI', k.avgAhi.toFixed(1), AHI_TIP)}
      {kpi('median leak', `${k.avgLeak.toFixed(1)} L/min`)}
    </section>
  )
}
