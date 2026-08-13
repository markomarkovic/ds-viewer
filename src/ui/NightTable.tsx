import { useState } from 'preact/hooks'
import type { Night } from '../types'
import { cmH2O, PARAM, WORKMODE } from '../types'

type SortKey = 'date' | 'hours' | 'p95' | 'ahi' | 'leak'
const getters: Record<SortKey, (n: Night) => number> = {
  date: (n) => n.date.getTime(),
  hours: (n) => n.hours,
  p95: (n) => n.press.p95,
  ahi: (n) => n.ahi,
  leak: (n) => n.leakMedian,
}

export function NightTable({
  nights,
  onSelect,
}: {
  nights: Night[]
  onSelect: (name: string) => void
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'date',
    desc: true,
  })
  const rows = [...nights].sort((a, b) => {
    const d = getters[sort.key](a) - getters[sort.key](b)
    return sort.desc ? -d : d
  })
  const header = (key: SortKey, label: string) => (
    <th
      style="cursor:pointer"
      onClick={() =>
        setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))
      }
    >
      {label}
      {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </th>
  )
  const fmtDur = (h: number) => {
    const s = Math.round(h * 3600)
    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
  }
  return (
    <table class="nights">
      <thead>
        <tr>
          {header('date', 'date')}
          {header('hours', 'duration')}
          <th>avg</th>
          <th>P90</th>
          {header('p95', 'P95')}
          <th>max</th>
          {header('ahi', 'AHI')}
          <th>apnea</th>
          {header('leak', 'leak')}
          <th>mode</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((n) => {
          const mode = n.sessions[0]?.params.get(PARAM.WorkMode)
          return (
            <tr
              key={n.name}
              style="cursor:pointer"
              onClick={() => onSelect(n.name)}
            >
              <td>
                {n.date.toLocaleDateString()} {n.partial ? '⚠' : ''}
              </td>
              <td>{fmtDur(n.hours)}</td>
              <td>{cmH2O(n.press.avg).toFixed(1)}</td>
              <td>{cmH2O(n.press.p90).toFixed(1)}</td>
              <td>{cmH2O(n.press.p95).toFixed(1)}</td>
              <td>{cmH2O(n.press.max).toFixed(1)}</td>
              <td>{n.ahi.toFixed(1)}</td>
              <td>{n.events.apnea}</td>
              <td>{n.leakMedian.toFixed(1)}</td>
              <td>{mode !== undefined ? (WORKMODE[mode] ?? mode) : '–'}</td>
              <td>▸</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
