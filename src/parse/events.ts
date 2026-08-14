import type { BreathTable, ScoredEvent } from '../types'

// Port of DP.Analysis.AnalysisFileV2.CalEvents (apnea + OSA/CSA split).
// The spec's "The algorithm" section is normative; constants and comparison
// order are verbatim. iBlockID is not ported (feeds only the vendor's file).
export function scoreEvents(table: BreathTable): ScoredEvent[] {
  const events: ScoredEvent[] = []
  const { count, insp, exp, nextInsp, tv, leak } = table
  for (let i = 2; i < count - 3; i++) {
    const pause = nextInsp[i]! - exp[i]!
    if (pause > 95 && pause < 495 && leak[i]! < 700) {
      const csa = tv[i - 1]! > tv[i]! && tv[i + 1]! < tv[i + 2]! && pause < 150
      const start = exp[i]!
      events.push({
        kind: csa ? 'CSA' : 'OSA',
        start,
        len: (insp[i + 1]! - start) & 0xffff, // vendor conv.u2 wrap
      })
    }
  }
  scoreHypopneas(table, events)
  return events
}

// pct(a, b) = (a - b) * 1.0 / a * 100 — operand order verbatim; NaN/Infinity
// from zero TVs fail every band test, matching the IL's unordered branches.
function pct(a: number, b: number): number {
  return (((a - b) * 1.0) / a) * 100
}

// Port of CalculationHI. Appends after the apneas (vendor list order).
function scoreHypopneas(table: BreathTable, events: ScoredEvent[]): void {
  const { count, insp, exp, tv } = table
  const n3 = count - 3
  for (let k = 2; k < n3; k++) {
    const r1 = pct(tv[k - 1]!, tv[k]!)
    const r2 = pct(tv[k - 2]!, tv[k]!)
    if (!(r1 > 30 && r1 < 70 && r2 > 30 && r2 < 70)) continue
    const start = insp[k]!
    for (let j = k; j < n3; j++) {
      const r3 = pct(tv[j + 1]!, tv[j]!)
      if (r3 > 30 && r3 < 70) {
        const len16 = (exp[j]! - start) & 0xffff
        if (Math.trunc(len16 / 10) > 9.5) {
          events.push({ kind: 'HYP', start, len: len16 })
          k = j // outer resumes at j + 1
        }
        break
      }
      const r4 = pct(tv[k - 1]!, tv[j]!)
      if (r4 < 30 || r4 > 70) break
      if (Math.trunc((insp[j]! - start) / 10) > 25) break
    }
  }
}
