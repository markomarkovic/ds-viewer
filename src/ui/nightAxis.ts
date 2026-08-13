import type { Night, Session } from '../types'
import { HZ } from '../types'

export type PlacedSession = { session: Session; offsetSec: number }

export function placeSessions(night: Night): PlacedSession[] {
  const noon = night.date.getTime()
  const out: PlacedSession[] = []
  let prevEnd = -Infinity
  for (const session of night.sessions) {
    let offsetSec = (session.start.getTime() - noon) / 1000
    if (offsetSec < prevEnd) offsetSec = prevEnd // clock anomaly: keep monotonic
    out.push({ session, offsetSec })
    prevEnd = offsetSec + session.press.length / HZ
  }
  return out
}

export function clockLabel(secSinceNoon: number): string {
  const h = (12 + Math.floor(secSinceNoon / 3600)) % 24
  const m = Math.floor((secSinceNoon % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

const DAY_S = 86400

export function nightGrid(
  night: Night,
  buckets: number,
  channel: 'press' | 'flow' | 'leak'
): { xs: Float64Array; min: Float64Array; max: Float64Array } {
  const xs = new Float64Array(buckets)
  const min = new Float64Array(buckets).fill(NaN)
  const max = new Float64Array(buckets).fill(NaN)
  const secPerBucket = DAY_S / buckets
  for (let b = 0; b < buckets; b++) xs[b] = (b + 0.5) * secPerBucket
  for (const { session, offsetSec } of placeSessions(night)) {
    const data = session[channel]
    const rate = channel === 'leak' ? 1 : HZ
    for (let i = 0; i < data.length; i++) {
      const sec = offsetSec + i / rate
      const b = Math.floor(sec / secPerBucket)
      if (b < 0 || b >= buckets) continue
      const v = data[i]!
      if (Number.isNaN(min[b]!) || v < min[b]!) min[b] = v
      if (Number.isNaN(max[b]!) || v > max[b]!) max[b] = v
    }
  }
  return { xs, min, max }
}

export type NightView = { startSec: number; windowSec: number }

/** First session start and last session end, in seconds since noon. */
export function nightBounds(night: Night): {
  firstStart: number
  lastEnd: number
} {
  const placed = placeSessions(night)
  const firstStart = placed[0]?.offsetSec ?? 0
  const last = placed[placed.length - 1]
  const lastEnd = last ? last.offsetSec + last.session.press.length / HZ : 0
  return { firstStart, lastEnd }
}
