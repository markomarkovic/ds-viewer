import { useState } from 'preact/hooks'
import uPlot from 'uplot'
import type { Night } from '../types'
import { cmH2O, deci, PARAM, WORKMODE } from '../types'
import { Chart } from './Chart'
import { Histogram } from './Histogram'
import { clockLabel, nightGrid, placeSessions } from './nightAxis'
import { Waveform } from './Waveform'

type Tab = 'pressure' | 'leak' | 'events'

export function NightDetail({
  night,
  onBack,
}: {
  night: Night
  onBack: () => void
}) {
  const [tab, setTab] = useState<Tab>('pressure')
  const [jumpSec, setJumpSec] = useState<number | null>(null)
  const first = night.sessions[0]
  const mode = first?.params.get(PARAM.WorkMode)
  const minP = first?.params.get(PARAM.MinPress)
  const maxP = first?.params.get(PARAM.MaxPress)
  return (
    <section>
      <nav>
        <ul>
          <li>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                onBack()
              }}
            >
              ← all nights
            </a>
          </li>
          <li>
            <strong>{night.date.toLocaleDateString()}</strong>{' '}
            <small>
              {mode !== undefined ? (WORKMODE[mode] ?? mode) : ''}{' '}
              {minP !== undefined && maxP !== undefined
                ? `${cmH2O(deci(minP)).toFixed(0)}–${cmH2O(deci(maxP)).toFixed(0)} cmH2O`
                : ''}{' '}
              · {night.sessions.length} session(s)
              {night.partial ? ' · ⚠ file truncated' : ''}
            </small>
          </li>
        </ul>
        <ul>
          {(['pressure', 'leak', 'events'] as const).map((t) => (
            <li key={t}>
              <button
                class={tab === t ? '' : 'outline'}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div style="display:grid; grid-template-columns: 2fr 1fr; gap: 1rem">
        <div>
          {tab === 'events' ? (
            <EventLanes night={night} onJump={setJumpSec} />
          ) : (
            <OverviewStrip night={night} channel={tab} onJump={setJumpSec} />
          )}
        </div>
        <Histogram night={night} />
      </div>
      <Waveform night={night} jumpSec={jumpSec} />
    </section>
  )
}

function OverviewStrip({
  night,
  channel,
  onJump,
}: {
  night: Night
  channel: 'pressure' | 'leak'
  onJump: (sec: number) => void
}) {
  const ch = channel === 'pressure' ? 'press' : 'leak'
  const g = nightGrid(night, 1024, ch)
  const scale = channel === 'pressure' ? 0.1 : 1 // press stored in deci
  const min = Array.from(g.min, (v) => (Number.isNaN(v) ? null : v * scale))
  const max = Array.from(g.max, (v) => (Number.isNaN(v) ? null : v * scale))
  return (
    <Chart
      deps={[night.name, channel]}
      build={(el, width) =>
        new uPlot(
          {
            width,
            height: 180,
            scales: { x: { time: false } },
            series: [
              {},
              { label: 'min', stroke: '#3a7ca5' },
              { label: 'max', stroke: '#3a7ca5' },
            ],
            bands: [{ series: [2, 1], fill: '#3a7ca544' }],
            axes: [
              {
                values: (_u, splits) => splits.map(clockLabel),
              },
              { label: channel === 'pressure' ? 'cmH2O' : 'L/min' },
            ],
            legend: { show: false },
            cursor: { drag: { x: false, y: false } },
            hooks: {
              ready: [
                (u) => {
                  u.over.addEventListener('click', (e) => {
                    const rect = u.over.getBoundingClientRect()
                    onJump(u.posToVal(e.clientX - rect.left, 'x'))
                  })
                },
              ],
            },
          },
          [Array.from(g.xs), min, max],
          el
        )
      }
    />
  )
}

function EventLanes({
  night,
  onJump,
}: {
  night: Night
  onJump: (sec: number) => void
}) {
  const placed = placeSessions(night)
  const lanes: Array<{ label: string; kind: string; color: string }> = [
    { label: 'apnea', kind: 'APNEA', color: '#c33' },
    { label: 'press up', kind: 'PRESS_UP', color: '#3a7ca5' },
    { label: 'press down', kind: 'PRESS_DOWN', color: '#8a6d3b' },
  ]
  return (
    <div>
      {lanes.map((lane) => (
        <div
          key={lane.kind}
          style="display:flex; align-items:center; gap:.5rem"
        >
          <small style="width:6rem">{lane.label}</small>
          <div style="position:relative; height:1.2rem; flex:1; background:var(--pico-muted-border-color)">
            {placed.flatMap(({ session, offsetSec }) =>
              session.events
                .filter((e) => e.kind === lane.kind)
                .map((e, i) => {
                  const sec = offsetSec + e.index / 10
                  return (
                    <span
                      key={`${offsetSec}-${i}`}
                      title={`${clockLabel(sec)} ${lane.label}`}
                      onClick={() => onJump(sec)}
                      style={`position:absolute; left:${(sec / 86400) * 100}%; width:2px; top:0; bottom:0; background:${lane.color}; cursor:pointer`}
                    />
                  )
                })
            )}
          </div>
        </div>
      ))}
      <small>
        {night.events.apnea} apnea · {night.events.pressUp} press-up ·{' '}
        {night.events.pressDown} press-down (device-flagged)
      </small>
    </div>
  )
}
