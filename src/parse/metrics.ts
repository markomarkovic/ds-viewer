import type { Deci, Lpm, Night, RawSession, Session } from '../types'
import { deci, FLOW_LPM, HZ } from '../types'
import { dateFromName } from './ds1'
import { lowpass, median } from './signal'

export function accumulateHistogram(
  press: Uint16Array,
  hist: Uint32Array
): void {
  for (let i = 0; i < press.length; i++) {
    const v = press[i]!
    hist[v > 300 ? 300 : v] = (hist[v > 300 ? 300 : v] ?? 0) + 1
  }
}

export function percentileDeci(hist: Uint32Array, n: number, p: number): Deci {
  const target = Math.floor((n * p) / 100)
  let cum = 0
  for (let b = 0; b < hist.length; b++) {
    cum += hist[b]!
    if (cum > target) return deci(b)
  }
  return deci(0)
}

export function buildNight(
  name: string,
  raw: RawSession[],
  partial: boolean
): Night {
  const date =
    dateFromName(name) ??
    (raw[0]
      ? new Date(
          raw[0].start.getFullYear(),
          raw[0].start.getMonth(),
          raw[0].start.getDate(),
          12,
          0,
          0
        )
      : null)
  if (!date) throw new Error(`cannot date night: ${name}`)

  const hist = new Uint32Array(301)
  let totalSamples = 0
  let pressSum = 0
  let maxSmoothed = 0
  let apnea = 0
  let pressUp = 0
  let pressDown = 0
  const baselines: Float64Array[] = []
  const sessions: Session[] = []

  for (const s of raw) {
    accumulateHistogram(s.press, hist)
    totalSamples += s.press.length
    for (let i = 0; i < s.press.length; i++) pressSum += s.press[i]!
    const smoothed = lowpass(s.press, 20)
    for (let i = 0; i < smoothed.length; i++)
      if (smoothed[i]! > maxSmoothed) maxSmoothed = smoothed[i]!
    for (const e of s.events) {
      if (e.kind === 'APNEA') apnea++
      else if (e.kind === 'PRESS_UP') pressUp++
      else if (e.kind === 'PRESS_DOWN') pressDown++
    }
    const base = lowpass(s.flow, 3)
    baselines.push(base)
    const leak = new Float32Array(Math.ceil(base.length / HZ))
    for (let i = 0; i < leak.length; i++) leak[i] = base[i * HZ]! * FLOW_LPM
    sessions.push({ ...s, leak })
  }

  const allBase = new Float64Array(
    baselines.reduce((acc, b) => acc + b.length, 0)
  )
  let off = 0
  for (const b of baselines) {
    allBase.set(b, off)
    off += b.length
  }
  allBase.sort()

  const hours = totalSamples / HZ / 3600
  return {
    name,
    date,
    sessions,
    hours,
    samples: totalSamples,
    press: {
      avg: deci(totalSamples ? Math.trunc(pressSum / totalSamples) : 0),
      median: percentileDeci(hist, totalSamples, 50),
      p90: percentileDeci(hist, totalSamples, 90),
      p95: percentileDeci(hist, totalSamples, 95),
      max: deci(maxSmoothed),
    },
    histogram: hist,
    leakMedian: (median(allBase) * FLOW_LPM) as Lpm,
    events: { apnea, pressUp, pressDown },
    ahi: hours > 0 ? apnea / hours : 0,
    partial,
  }
}
