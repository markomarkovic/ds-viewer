import type { BreathMetrics, BreathTable, Lpm } from '../types'
import { deci, HZ, ml } from '../types'
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

    if (inInsp)
      tvAcc += Math.abs(roundHalfEven(Math.fround(prevFlow - prevThr)))
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

// vendor Avg: .NET Average<float> sums in f64, returns f32; then (int) truncates
function truncAvgF32(xs: ArrayLike<number>): number {
  let sum = 0
  for (let i = 0; i < xs.length; i++) sum += xs[i]!
  return Math.trunc(Math.fround(sum / xs.length))
}

// vendor CalculatedValue(list, abnVal, 2): values >= abnVal are replaced by 0
// (still counted in the denominator), then f32-average, then (int) truncation
function abnAvg(xs: ArrayLike<number>, abn: number): number {
  const bound = Math.fround(abn)
  let sum = 0
  for (let i = 0; i < xs.length; i++) sum += xs[i]! < bound ? xs[i]! : 0
  return Math.trunc(Math.fround(sum / xs.length))
}

type CalPress = {
  min: number
  max: number
  p50: number
  p90: number
  p95: number
  p98: number
}

// Port of CalPress: histogram of trunc(pressSmooth[i]) clamped into [40, 300]
// over the WHOLE padded night (blank blocks land in the 40 bin), percentile =
// first bin whose cumulative permille, rounded half-to-even, reaches the
// threshold. These P90/P95 are what the vendor's reports print as
// "Horizontal Pressure". Min excludes the head/tail trim and requires v > 40;
// max is capped at P98 + 50 ("abnormal pressure").
function calPress(pressSmooth: Float32Array): CalPress {
  const n = pressSmooth.length
  const count = new Int32Array(301)
  let min = 100
  let max = 0
  for (let i = 0; i < n; i++) {
    let v = Math.trunc(pressSmooth[i]!)
    if (v < 40) v = 40
    if (v > 300) v = 300
    if (v > 40 && v < min && i > MINUTE_DATA && i < n - MINUTE_DATA) min = v
    if (v > max) max = v
    count[v]!++
  }
  let cum = 0
  let p50 = 0
  let p90 = 0
  let p95 = 0
  let p98 = 0
  for (let b = 0; b <= 300; b++) {
    cum += count[b]!
    const bar = roundHalfEven((1000 * cum) / n)
    if (bar >= 500 && p50 === 0) p50 = b
    if (bar >= 900 && p90 === 0) p90 = b
    if (bar >= 950 && p95 === 0) p95 = b
    if (bar >= 980 && p98 === 0) p98 = b
  }
  if (max > p98 + 50) max = p98 + 50
  return { min, max, p50, p90, p95, p98 }
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
  const press = calPress(pressSmooth)

  // vendor Abn* outlier bounds for the Avg fields (GetInspExpPress)
  const abnTv = percentileVendor(tvS, 98) + 200
  const abnBpm = percentileVendor(bpmS, 95) + 50
  const abnIe = percentileVendor(ieS, 98) + 10
  const abnMv = percentileVendor(mvS, 98) + 1000
  const abnLeak = percentileVendor(leakS, 98) + 100

  return {
    breaths: tvL.length,
    // p90/p95 are CalPress bins — the values the vendor's reports print as
    // Horizontal Pressure P90/P95. avg/min stay with the expiratory pool
    // (the vendor's ExpPresAvg/ExpPresMin fields).
    expPress: {
      avg: deci(truncAvgF32(expS)),
      min: deci(Math.max(Math.trunc(expS[0]!), press.min)),
      p90: deci(press.p90),
      p95: deci(press.p95),
    },
    inspPress: {
      avg: deci(truncAvgF32(inspS)),
      max: deci(Math.min(Math.trunc(inspS[inspS.length - 1]!), press.max)),
      p90: deci(percentileVendor(inspS, 90)),
      p95: deci(percentileVendor(inspS, 95)),
    },
    tv: {
      avg: ml(abnAvg(tvL, abnTv)),
      p50: ml(percentileVendor(tvS, 50)),
      p90: ml(percentileVendor(tvS, 90)),
      p95: ml(percentileVendor(tvS, 95)),
    },
    bpm: {
      avg: abnAvg(bpmL, abnBpm) / 10,
      p50: percentileVendor(bpmS, 50) / 10,
      p90: percentileVendor(bpmS, 90) / 10,
      p95: percentileVendor(bpmS, 95) / 10,
    },
    ie: {
      avg: abnAvg(ieL, abnIe) / 10,
      p50: percentileVendor(ieS, 50) / 10,
      p90: percentileVendor(ieS, 90) / 10,
      p95: percentileVendor(ieS, 95) / 10,
    },
    mv: {
      avg: ml(abnAvg(mvL, abnMv)),
      p50: ml(percentileVendor(mvS, 50)),
      p90: ml(percentileVendor(mvS, 90)),
      p95: ml(percentileVendor(mvS, 95)),
    },
    // iLeak is smoothed flow in raw counts; the vendor prints count/10 as
    // L/min (SetMaskState divides iLeak by 10 the same way), so the branded
    // values are cast directly rather than put through lpm()'s FLOW_LPM.
    leak: {
      avg: (abnAvg(leakL, abnLeak) / 10) as Lpm,
      p50: (percentileVendor(leakS, 50) / 10) as Lpm,
      p90: (percentileVendor(leakS, 90) / 10) as Lpm,
      p95: (percentileVendor(leakS, 95) / 10) as Lpm,
    },
  }
}
