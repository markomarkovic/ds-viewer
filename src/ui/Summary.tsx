import type { Night } from '../types'
import { kpis } from '../state'

export function Summary({ nights }: { nights: Night[] }) {
  const k = kpis(nights)
  const kpi = (label: string, value: string) => (
    <div style="text-align:center">
      <h4 style="margin-bottom:0">{value}</h4>
      <small>{label}</small>
    </div>
  )
  return (
    <section style="display:grid; grid-template-columns:repeat(5,1fr); gap:1rem">
      {kpi('nights', String(k.count))}
      {kpi('avg duration', `${k.avgHours.toFixed(1)} h`)}
      {kpi('avg P95', `${k.avgP95.toFixed(1)} cmH2O`)}
      {kpi('avg AHI', k.avgAhi.toFixed(1))}
      {kpi('median leak', `${k.avgLeak.toFixed(1)} L/min`)}
    </section>
  )
}
