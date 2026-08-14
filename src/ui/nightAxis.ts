import type { Night, ScoredEvent, Session } from '../types'
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

/**
 * Display position of a scored event, in seconds since noon.
 *
 * The stored interval is the vendor-validated event and is never modified.
 * This maps it into its containing session (anchoring there also avoids the
 * padded timeline's small cumulative drift vs recorded session starts) and
 * then, display-only, slides the bracket LEFT by up to its own length onto
 * the quietest same-length flow window when that window is clearly quieter:
 * the vendor's segmenter occasionally anchors an apnea one shallow breath
 * late, which would otherwise draw the bracket over the post-pause breaths.
 */
export function scoredSpanSec(
  night: Night,
  e: ScoredEvent
): { from: number; to: number } {
  const placed = placeSessions(night)
  let padded = 0
  let k = 0
  let inSession = e.start
  for (let i = 0; i < night.sessions.length; i++) {
    if (i > 0) {
      const gapMs =
        night.sessions[i]!.start.getTime() -
        night.sessions[i - 1]!.end.getTime()
      padded += Math.abs(Math.trunc(gapMs / 1000)) * HZ
    }
    if (e.start >= padded) {
      k = i
      inSession = e.start - padded
    }
    padded += night.sessions[i]!.press.length
  }
  const flow = night.sessions[k]?.flow
  const start = flow ? snapLeft(flow, inSession, e.len) : inSession
  const from = (placed[k]?.offsetSec ?? 0) + start / HZ
  return { from, to: from + e.len / HZ }
}

// Slide-left-only snap: the quietest same-length window in [s0-len, s0]
// (total flow variation), taken only when clearly quieter than the stored
// window (< 70%), so correctly-placed brackets never jitter.
function snapLeft(flow: ArrayLike<number>, s0: number, len: number): number {
  const lo = Math.max(0, s0 - len)
  const hi = s0
  if (len <= 0 || s0 < 0 || s0 + len > flow.length || hi <= lo) return s0
  const n = hi + len - lo
  const pre = new Float64Array(n)
  for (let i = 1; i < n; i++)
    pre[i] = pre[i - 1]! + Math.abs(flow[lo + i]! - flow[lo + i - 1]!)
  const tv = (w: number) => pre[w - lo + len - 1]! - pre[w - lo]!
  const cur = tv(s0)
  let best = s0
  let bestTv = cur
  for (let w = lo; w <= hi; w++) {
    const t = tv(w)
    if (t < bestTv) {
      bestTv = t
      best = w
    }
  }
  return bestTv < cur * 0.7 ? best : s0
}
