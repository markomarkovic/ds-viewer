// Opt-in: only runs when DS1_DIR points at a directory of real .ds1 files.
//   make test-diff DS1_DIR=~/Downloads/dreamsleep
// Never runs in CI; real recordings are health data and never enter the repo.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { buildNight } from '../parse/metrics'
import { parseDs1 } from '../parse/ds1'
import { cmH2O } from '../types'

const dir = process.env['DS1_DIR']?.replace(/^~/, process.env['HOME'] ?? '')
const d = dir ? describe : describe.skip

d('differential vs ds1.py', () => {
  const dataDir = resolve(dir ?? '')
  const files = readdirSync(dataDir).filter((f) => f.endsWith('.ds1'))
  const out = mkdtempSync(join(tmpdir(), 'ds1diff-'))
  execFileSync(
    'python3',
    ['ds1.py', '--export', out, ...files.map((f) => join(dataDir, f))],
    { cwd: resolve(import.meta.dirname, '../..'), stdio: 'ignore' }
  )
  afterAll(() => rmSync(out, { recursive: true, force: true }))

  const nights = new Map(
    files.map((f) => {
      const buf = readFileSync(join(dataDir, f))
      const { sessions, partial } = parseDs1(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        f
      )
      const stem = f.replace(/\.ds1$/, '')
      return [stem, buildNight(stem, sessions, partial)] as const
    })
  )

  test('sessions.csv matches per-session metrics', () => {
    const lines = readFileSync(join(out, 'sessions.csv'), 'utf8')
      .trim()
      .split('\n')
    const header = lines[0]!.split(',')
    const col = (name: string) => header.indexOf(name)
    expect(col('avg_pressure_cmh2o')).toBeGreaterThan(-1)
    let checked = 0
    for (const line of lines.slice(1)) {
      const c = line.split(',')
      const night = nights.get(c[col('file')]!)
      expect(night, `night ${c[0]} missing`).toBeDefined()
      if (!night) continue
      const si = Number(c[col('session')]) - 1
      const s = night.sessions[si]
      expect(s, `session ${c[0]}#${si}`).toBeDefined()
      if (!s) continue
      expect(s.press.length).toBe(Number(c[col('samples')]))
      // per-session re-derivation for the columns ds1.py reports per session
      const perSession = buildNight(c[col('file')]!, [s], false)
      expect(cmH2O(perSession.press.avg).toFixed(1)).toBe(
        Number(c[col('avg_pressure_cmh2o')]).toFixed(1)
      )
      expect(cmH2O(perSession.press.median).toFixed(1)).toBe(
        Number(c[col('median_pressure_cmh2o')]).toFixed(1)
      )
      expect(cmH2O(perSession.press.max)).toBeCloseTo(
        Number(c[col('max_pressure_cmh2o')]),
        1
      )
      expect(perSession.leakMedian).toBeCloseTo(
        Number(c[col('median_leak_lpm')]),
        1
      )
      expect(perSession.events.apnea).toBe(Number(c[col('apnea')]))
      expect(perSession.events.pressUp).toBe(Number(c[col('press_up')]))
      expect(perSession.events.pressDown).toBe(Number(c[col('press_down')]))
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })

  test('waveform CSVs match sample-for-sample', () => {
    let rows = 0
    for (const [stem, night] of nights) {
      const csv = readFileSync(join(out, `${stem}.csv`), 'utf8')
        .trim()
        .split('\n')
      // header: session,t_s,timestamp,pressure_cmh2o,flow_lpm
      let li = 1
      for (let si = 0; si < night.sessions.length; si++) {
        const s = night.sessions[si]!
        for (let i = 0; i < s.press.length; i++, li++) {
          const c = csv[li]!.split(',')
          if (Number(c[0]) !== si + 1)
            throw new Error(`session misalign ${stem}:${li}`)
          const press = Number(c[3])
          const flow = Number(c[4])
          if (Math.abs(press - s.press[i]! / 10) > 1e-9)
            throw new Error(`press mismatch ${stem}:${li}`)
          if (Math.abs(flow - s.flow[i]! * 0.12) > 0.005)
            throw new Error(`flow mismatch ${stem}:${li}`)
          rows++
        }
      }
      expect(li).toBe(csv.length)
    }
    expect(rows).toBeGreaterThan(1_000_000)
  })
})
