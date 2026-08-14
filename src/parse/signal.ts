export function lowpass(x: ArrayLike<number>, a: number): Float64Array {
  const k = a / 100
  const y = Float64Array.from(x)
  if (y.length === 0) return y
  let prev = y[0]!
  for (let i = 0; i < y.length; i++) {
    y[i] = prev * (1 - k) + y[i]! * k
    prev = y[i]!
  }
  prev = y[y.length - 1]!
  for (let i = y.length - 1; i >= 0; i--) {
    y[i] = prev * (1 - k) + y[i]! * k
    prev = y[i]!
  }
  return y
}

export function median(sorted: Float64Array): number {
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!
}

export function lowpassF32(x: ArrayLike<number>, a: number): Float32Array {
  const k = Math.fround(a / 100)
  const y = Float32Array.from(x)
  if (y.length === 0) return y
  let prev = y[0]!
  for (let i = 0; i < y.length; i++) {
    y[i] = prev * (1 - k) + y[i]! * k // Float32Array store rounds to f32
    prev = y[i]!
  }
  prev = y[y.length - 1]!
  for (let i = y.length - 1; i >= 0; i--) {
    y[i] = prev * (1 - k) + y[i]! * k
    prev = y[i]!
  }
  return y
}

/** .NET Math.Round: round half to even (banker's rounding). */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x)
  const diff = x - f
  if (diff < 0.5) return f
  if (diff > 0.5) return f + 1
  return f % 2 === 0 ? f : f + 1
}

/**
 * Vendor Percentile helper: element floor(n*p/100) of the ascending-sorted
 * list, truncated to int. Precondition: sorted, non-empty. The index is not
 * clamped; callers only pass p in {50, 90, 95}.
 */
export function percentileVendor(sorted: Float32Array, p: number): number {
  return Math.trunc(sorted[Math.floor((sorted.length * p) / 100)]!)
}
