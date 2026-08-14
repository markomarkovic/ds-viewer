// Opt-in oracle: breath-derived metrics vs the vendor's own saved reports.
//   make test-reports DS1_DIR=~/Downloads/dreamsleep
// Requires expected.json in DS1_DIR (tools/reports-to-json.py). Never in CI.
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildNight } from '../parse/metrics'
import { parseDs1 } from '../parse/ds1'
import type { BreathMetrics } from '../types'

type Quart = { avg: number; p50: number; p90: number; p95: number }
type Expected = {
  daily: {
    date: string
    tv: Quart
    bpm: Quart
    leak: Quart
    ie: Omit<Quart, 'avg'>
  }
  nights: Array<{ date: string; p90: number; p95: number }>
  aggregates: {
    tv: Omit<Quart, 'avg'>
    bpm: Omit<Quart, 'avg'>
    ie: Omit<Quart, 'avg'>
    mv: Omit<Quart, 'avg'>
  }
}

const dir = process.env['DS1_DIR']?.replace(/^~/, process.env['HOME'] ?? '')
const d = dir ? describe : describe.skip

d('breath metrics vs vendor reports', () => {
  if (!dir) return
  const dataDir = resolve(dir)
  const expected = JSON.parse(
    readFileSync(join(dataDir, 'expected.json'), 'utf8')
  ) as Expected

  const byDate = new Map<string, BreathMetrics>()
  for (const f of readdirSync(dataDir).filter((f) => f.endsWith('.ds1'))) {
    const buf = readFileSync(join(dataDir, f))
    const { sessions, partial } = parseDs1(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      f
    )
    const stem = f.replace(/\.ds1$/, '')
    const night = buildNight(stem, sessions, partial)
    if (!night.breath) continue
    const dt = night.date
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    byDate.set(key, night.breath)
  }

  const daily = () => {
    const b = byDate.get(expected.daily.date)
    if (!b) throw new Error(`daily night ${expected.daily.date} not decoded`)
    return b
  }
  const d10 = (x: number) => Math.round(x * 10)

  test('assertion 1: expiratory P90/P95 exact, every night', () => {
    let checked = 0
    for (const row of expected.nights) {
      const b = byDate.get(row.date)
      expect(b, `night ${row.date} missing`).toBeDefined()
      if (!b) continue
      expect(b.expPress.p90, `${row.date} P90`).toBe(d10(row.p90))
      expect(b.expPress.p95, `${row.date} P95`).toBe(d10(row.p95))
      checked++
    }
    expect(checked).toBe(expected.nights.length)
  })

  test('assertion 2: TV exact, daily night', () => {
    const b = daily()
    const e = expected.daily.tv
    expect(b.tv.avg).toBe(e.avg)
    expect(b.tv.p50).toBe(e.p50)
    expect(b.tv.p90).toBe(e.p90)
    expect(b.tv.p95).toBe(e.p95)
  })

  test('assertion 3: BPM exact, daily night', () => {
    const b = daily()
    const e = expected.daily.bpm
    expect(d10(b.bpm.avg)).toBe(d10(e.avg))
    expect(d10(b.bpm.p50)).toBe(d10(e.p50))
    expect(d10(b.bpm.p90)).toBe(d10(e.p90))
    expect(d10(b.bpm.p95)).toBe(d10(e.p95))
  })

  test('assertion 4: leak within 0.2 L/min, daily night', () => {
    const b = daily()
    const e = expected.daily.leak
    for (const [ours, theirs] of [
      [b.leak.avg, e.avg],
      [b.leak.p50, e.p50],
      [b.leak.p90, e.p90],
      [b.leak.p95, e.p95],
    ] as const)
      expect(Math.abs(ours - theirs)).toBeLessThanOrEqual(0.2)
  })

  const meanOf = (f: (b: BreathMetrics) => number) => {
    const vs = [...byDate.values()].map(f)
    return vs.reduce((a, x) => a + x, 0) / vs.length
  }
  const closeTo = (ours: number, theirs: number, label: string) =>
    expect(Math.abs(ours - theirs), label).toBeLessThanOrEqual(0.05)

  test('assertion 5: 13-night mean of TV and BPM at 50/90/95', () => {
    for (const p of ['p50', 'p90', 'p95'] as const) {
      closeTo(
        meanOf((b) => b.tv[p]),
        expected.aggregates.tv[p],
        `tv ${p}`
      )
      closeTo(
        meanOf((b) => b.bpm[p]),
        expected.aggregates.bpm[p],
        `bpm ${p}`
      )
    }
  })

  test('assertion 6: 13-night mean of I:E at 50/90/95', () => {
    for (const p of ['p50', 'p90', 'p95'] as const)
      closeTo(
        meanOf((b) => b.ie[p]),
        expected.aggregates.ie[p],
        `ie ${p}`
      )
  })

  test('assertion 7: 13-night mean of minute volume at 50/90/95', () => {
    for (const p of ['p50', 'p90', 'p95'] as const)
      closeTo(
        meanOf((b) => b.mv[p]),
        expected.aggregates.mv[p],
        `mv ${p}`
      )
  })
})
