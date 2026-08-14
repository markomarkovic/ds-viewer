// Opt-in per-event oracle: our scorer vs the vendor's own .EVT5 output.
//   make test-events DS1_DIR=~/Downloads/dreamsleep
// The .EVT5s were written by the vendor over chunk-truncated reads, so the
// harness truncates the same way (viewer keeps whole files).
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildNight } from '../parse/metrics'
import { parseDs1 } from '../parse/ds1'
import type { Night, ScoredKind } from '../types'
import { readEvt5 } from './evt5'

const KIND_BY_TYPE: Record<number, ScoredKind> = {
  0x15: 'OSA',
  0x16: 'CSA',
  0x17: 'HYP',
}

const dir = process.env['DS1_DIR']?.replace(/^~/, process.env['HOME'] ?? '')
const d = dir ? describe : describe.skip

d('scored events vs vendor .EVT5', () => {
  if (!dir) return
  const dataDir = resolve(dir)
  const nights: Array<{ stem: string; night: Night; evtPath: string }> = []
  for (const f of readdirSync(dataDir).filter((f) => f.endsWith('.ds1'))) {
    const stem = f.replace(/\.ds1$/, '')
    const evtPath = join(dataDir, `${stem}.EVT5`)
    if (!existsSync(evtPath)) continue
    const buf = readFileSync(join(dataDir, f))
    const chunked = Math.floor(buf.byteLength / 4096) * 4096
    const { sessions, partial } = parseDs1(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + chunked),
      f
    )
    nights.push({ stem, night: buildNight(stem, sessions, partial), evtPath })
  }

  test('per-event equality: type, start, duration, file order', () => {
    let compared = 0
    for (const { stem, night, evtPath } of nights) {
      const evt = readFileSync(evtPath)
      // compare against the vendor's AUTO scoring only: using the vendor app
      // on the corpus appends user-confirmed/edited records (iValidation 1),
      // which are human annotations, not scorer output
      const expected = readEvt5(
        evt.buffer.slice(evt.byteOffset, evt.byteOffset + evt.byteLength)
      ).filter((e) => e.validation === 0)
      const ours = night.scored ?? []
      expect(ours.length, `${stem} count`).toBe(expected.length)
      for (let i = 0; i < expected.length; i++) {
        const e = expected[i]!
        const o = ours[i]!
        expect(o.kind, `${stem}[${i}] kind`).toBe(KIND_BY_TYPE[e.type])
        expect(o.start * 100, `${stem}[${i}] start`).toBe(e.startMs)
        expect(o.len * 100, `${stem}[${i}] len`).toBe(e.lenMs)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(2500) // corpus holds 3042 events
  })

  test('report cross-check: per-night apnea count and AHI', () => {
    const expected = JSON.parse(
      readFileSync(join(dataDir, 'expected.json'), 'utf8')
    ) as {
      daily: { date: string; ahi: number; osa: number; csa: number }
      nights: Array<{ date: string; ahi: number; apnea: number }>
    }
    const byDate = new Map(
      nights.map(({ night }) => {
        const dt = night.date
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
        return [key, night] as const
      })
    )
    for (const row of expected.nights) {
      // 2026-08-13: the statistical report's row describes the file as of
      // report generation, but the current 13082026.ds1 has extra sessions
      // and its .EVT5 was generated from the current file. The per-event
      // test above confirms our scorer matches that .EVT5 exactly, so this
      // mismatch is the file/report having diverged, not a scoring bug.
      // Excluded from this report cross-check only — never from the
      // per-event test.
      if (row.date === '2026-08-13') continue
      const n = byDate.get(row.date)
      expect(n, `night ${row.date}`).toBeDefined()
      if (!n) continue
      const apneas = (n.scored ?? []).filter((e) => e.kind !== 'HYP').length
      expect(apneas, `${row.date} apnea count`).toBe(row.apnea)
      expect(n.ahiScored, `${row.date} AHI`).toBe(row.ahi)
    }
    const daily = byDate.get(expected.daily.date)!
    const sc = daily.scored ?? []
    expect(sc.filter((e) => e.kind === 'OSA')).toHaveLength(expected.daily.osa)
    expect(sc.filter((e) => e.kind === 'CSA')).toHaveLength(expected.daily.csa)
  })
})
