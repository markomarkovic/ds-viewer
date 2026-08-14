import type { BreathMetrics, BreathTable } from '../types'
import { deci, HZ, lpm, ml } from '../types'
import { percentileVendor, roundHalfEven } from './signal'

type TBreath = {
  iInsp: number
  iExp: number
  iNextInsp: number
  iTV: number
  iBPM: number
  iLeak: number
}

// Port of DP.Analysis.AnalysisFileV2.CalIsnpExp, DataVer==1 (.ds1).
// The vendor's iMV store and the InsMaxPress/ExpMinPress fields are omitted:
// nothing observable reads them (see plan, Spec Reconciliation #3).
export function segmentBreaths(
  flowSmooth: Float32Array,
  flowBase: Float32Array
): BreathTable {
  const breaths: TBreath[] = []
  let inInsp = false
  let armed = true
  let tvAcc = 0
  let zeroRun = 0

  for (let n = 10; n <= flowSmooth.length - 3; n++) {
    const prevFlow = flowSmooth[n - 1]!
    const nextFlow = flowSmooth[n + 1]!
    const prevThr = Math.fround(flowBase[n - 1]! + 3)
    const nextThr = Math.fround(flowBase[n + 1]! + 3)

    if (flowSmooth[n] === 0) zeroRun++

    // rising crossing of the threshold -> inspiration starts
    if (armed && prevThr - prevFlow > 0.1 && nextFlow - nextThr >= 0) {
      inInsp = true
      armed = false
      breaths.push({
        iInsp: n,
        iExp: 0,
        iNextInsp: 0,
        iTV: 0,
        iBPM: 0,
        iLeak: prevFlow,
      })
      const k = breaths.length - 1
      if (k > 0) {
        const prev = breaths[k - 1]!
        prev.iNextInsp = n - zeroRun
        prev.iBPM = Math.fround(600 / (prev.iNextInsp - prev.iInsp))
        zeroRun = 0
      }
    }

    if (inInsp) tvAcc += Math.abs(roundHalfEven(prevFlow - prevThr))
    else tvAcc = 0

    // falling crossing -> expiration starts, closing the breath
    if (inInsp && prevFlow - prevThr > 0.1 && nextThr - nextFlow > 0) {
      inInsp = false
      armed = true
      const cur = breaths[breaths.length - 1]!
      cur.iExp = n
      cur.iTV = roundHalfEven(tvAcc / 5)
    }
  }

  // small-breath merge; indices collected up front, removed in reverse so
  // earlier indices stay valid. The guard re-reads the shrinking length.
  const small: number[] = []
  for (let i = 2; i < breaths.length; i++)
    if (breaths[i]!.iTV <= 20) small.push(i)
  for (let j = small.length - 1; j >= 0; j--) {
    const i = small[j]!
    if (i + 1 >= breaths.length - 1) continue
    breaths[i - 1]!.iNextInsp = breaths[i + 1]!.iInsp
    breaths.splice(i, 1) // iBPM of breaths[i-1] deliberately left stale
  }

  return {
    count: breaths.length,
    insp: Int32Array.from(breaths, (b) => b.iInsp),
    exp: Int32Array.from(breaths, (b) => b.iExp),
    nextInsp: Int32Array.from(breaths, (b) => b.iNextInsp),
    tv: Int32Array.from(breaths, (b) => b.iTV),
    bpm: Float32Array.from(breaths, (b) => b.iBPM),
    leak: Float32Array.from(breaths, (b) => b.iLeak),
  }
}

export const MINUTE_DATA = 300 * HZ // head/tail trim, samples

function sortedF32(xs: number[]): Float32Array {
  return Float32Array.from(xs).sort()
}

// vendor Avg: (int)Math.Round(mean, 2) — see plan, Spec Reconciliation #2
function vendorAvg(sorted: Float32Array): number {
  let sum = 0
  for (let i = 0; i < sorted.length; i++) sum += sorted[i]!
  return Math.trunc(roundHalfEven((sum / sorted.length) * 100) / 100)
}

// Port of CalPress: min/max of pressSmooth clamped into [40, 300], first and
// last MINUTE_DATA samples excluded. Does not mutate the array.
function calPressBounds(pressSmooth: Float32Array): {
  min: number
  max: number
} {
  let min = 300
  let max = 40
  for (let i = MINUTE_DATA; i < pressSmooth.length - MINUTE_DATA; i++) {
    const v = Math.min(300, Math.max(40, pressSmooth[i]!))
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min: Math.trunc(min), max: Math.trunc(max) }
}

// Port of DP.Analysis.AnalysisFileV2.GetInspExpPress.
export function reduceBreaths(
  table: BreathTable,
  pressSmooth: Float32Array
): BreathMetrics | null {
  const inspSamples: number[] = []
  const expSamples: number[] = []
  const tvL: number[] = []
  const leakL: number[] = []
  const bpmL: number[] = []
  const mvL: number[] = []
  const ieL: number[] = []

  for (let b = 0; b < table.count; b++) {
    const iInsp = table.insp[b]!
    const iExp = table.exp[b]!
    const iNextInsp = table.nextInsp[b]!
    const tv = table.tv[b]!
    const bpm = table.bpm[b]!
    if (iInsp < MINUTE_DATA) continue

    // appends precede the break test: the breath that ends the loop still
    // contributes to every list except the two pressure pools
    tvL.push(tv)
    leakL.push(table.leak[b]!)
    bpmL.push(Math.fround(bpm * 10))
    mvL.push(Math.fround(bpm * tv))
    ieL.push(Math.fround(((iNextInsp - iExp) / (iExp - iInsp)) * 10))

    const end = Math.min(iNextInsp, pressSmooth.length)
    const inspFrom = iInsp + Math.trunc((iExp - iInsp) / 3)
    const expFrom = iExp + Math.trunc((iNextInsp - iExp) / 3)
    if (end > pressSmooth.length - MINUTE_DATA) break

    for (let i = iInsp; i < end; i++) {
      const p = pressSmooth[i]!
      if (i > inspFrom && i < iExp) inspSamples.push(p)
      if (i > expFrom && i < end && p >= 40) expSamples.push(p)
    }
  }

  if (inspSamples.length === 0 || expSamples.length === 0) return null

  const inspS = sortedF32(inspSamples)
  const expS = sortedF32(expSamples)
  const tvS = sortedF32(tvL)
  const bpmS = sortedF32(bpmL)
  const ieS = sortedF32(ieL)
  const mvS = sortedF32(mvL)
  const leakS = sortedF32(leakL)
  const bounds = calPressBounds(pressSmooth)

  return {
    breaths: tvL.length,
    expPress: {
      avg: deci(vendorAvg(expS)),
      min: deci(Math.max(Math.trunc(expS[0]!), bounds.min)),
      p90: deci(percentileVendor(expS, 90)),
      p95: deci(percentileVendor(expS, 95)),
    },
    inspPress: {
      avg: deci(vendorAvg(inspS)),
      max: deci(Math.min(Math.trunc(inspS[inspS.length - 1]!), bounds.max)),
      p90: deci(percentileVendor(inspS, 90)),
      p95: deci(percentileVendor(inspS, 95)),
    },
    tv: {
      avg: ml(vendorAvg(tvS)),
      p50: ml(percentileVendor(tvS, 50)),
      p90: ml(percentileVendor(tvS, 90)),
      p95: ml(percentileVendor(tvS, 95)),
    },
    bpm: {
      avg: vendorAvg(bpmS) / 10,
      p50: percentileVendor(bpmS, 50) / 10,
      p90: percentileVendor(bpmS, 90) / 10,
      p95: percentileVendor(bpmS, 95) / 10,
    },
    ie: {
      avg: vendorAvg(ieS) / 10,
      p50: percentileVendor(ieS, 50) / 10,
      p90: percentileVendor(ieS, 90) / 10,
      p95: percentileVendor(ieS, 95) / 10,
    },
    mv: {
      avg: ml(vendorAvg(mvS)),
      p50: ml(percentileVendor(mvS, 50)),
      p90: ml(percentileVendor(mvS, 90)),
      p95: ml(percentileVendor(mvS, 95)),
    },
    leak: {
      avg: lpm(vendorAvg(leakS)),
      p50: lpm(percentileVendor(leakS, 50)),
      p90: lpm(percentileVendor(leakS, 90)),
      p95: lpm(percentileVendor(leakS, 95)),
    },
  }
}
