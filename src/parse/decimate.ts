export type Envelope = { min: Float64Array; max: Float64Array }

export function minmaxEnvelope(
  data: ArrayLike<number>,
  from: number,
  to: number,
  width: number
): Envelope {
  const n = to - from
  if (n <= width) {
    const raw = new Float64Array(Math.max(n, 0))
    for (let i = 0; i < raw.length; i++) raw[i] = data[from + i]!
    return { min: raw, max: Float64Array.from(raw) }
  }
  const min = new Float64Array(width)
  const max = new Float64Array(width)
  for (let b = 0; b < width; b++) {
    const s = from + Math.floor((b * n) / width)
    const e = from + Math.floor(((b + 1) * n) / width)
    let lo = Infinity
    let hi = -Infinity
    for (let i = s; i < e; i++) {
      const v = data[i]!
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    min[b] = lo
    max[b] = hi
  }
  return { min, max }
}
