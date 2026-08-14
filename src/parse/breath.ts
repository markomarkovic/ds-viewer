import type { BreathTable } from '../types'
import { roundHalfEven } from './signal'

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
