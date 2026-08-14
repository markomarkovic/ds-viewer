import { useState } from 'preact/hooks'
import type { Night } from '../types'
import { cmH2O, PARAM, WORKMODE } from '../types'

type SortKey =
  | 'date'
  | 'hours'
  | 'avg'
  | 'p90'
  | 'p95'
  | 'max'
  | 'ahi'
  | 'apnea'
  | 'leak'
  | 'mode'
const getters: Record<SortKey, (n: Night) => number> = {
  date: (n) => n.date.getTime(),
  hours: (n) => n.hours,
  avg: (n) => n.press.avg,
  p90: (n) => n.press.p90,
  p95: (n) => n.press.p95,
  max: (n) => n.press.max,
  ahi: (n) => n.ahiScored ?? n.ahi,
  apnea: (n) =>
    n.scored ? n.scored.filter((e) => e.kind !== 'HYP').length : n.events.apnea,
  leak: (n) => n.leakMedian,
  mode: (n) => n.sessions[0]?.params.get(PARAM.WorkMode) ?? -1,
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
          {header('avg', 'avg')}
          {header('p90', 'P90')}
          {header('p95', 'P95')}
          {header('max', 'max')}
          {header('ahi', 'AHI')}
          {header('apnea', 'apnea')}
          {header('leak', 'leak')}
          {header('mode', 'mode')}
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
              <td>{(n.ahiScored ?? n.ahi).toFixed(1)}</td>
              <td
                data-tooltip={
                  n.scored ? `device flags: ${n.events.apnea}` : undefined
                }
              >
                {n.scored
                  ? n.scored.filter((e) => e.kind !== 'HYP').length
                  : n.events.apnea}
              </td>
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
