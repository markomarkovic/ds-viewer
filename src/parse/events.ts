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
  return events
}
