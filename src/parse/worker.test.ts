import { expect, test } from 'vitest'
import { simpleNight } from '../test/encode'
import { handle } from './worker'

test('handle parses a file into a night and lists its buffers as transfers', () => {
  const buf = simpleNight({ sampleCount: 100 })
  const { res, transfers } = handle({ id: 7, name: '13082026.ds1', buf })
  expect(res.id).toBe(7)
  if (!res.ok) throw new Error(res.error)
  expect(res.night.name).toBe('13082026')
  expect(res.night.samples).toBe(100)
  // press + flow + leak per session = 3 transferables
  expect(transfers).toHaveLength(3)
  expect(transfers[0]).toBeInstanceOf(ArrayBuffer)
})

test('handle reports failure instead of throwing', () => {
  const { res, transfers } = handle({
    id: 1,
    name: 'mystery.ds1',
    buf: new Uint8Array([0x90, 0, 0, 0]).buffer, // orphan sample, undateable name
  })
  expect(res.ok).toBe(false)
  if (res.ok) throw new Error('expected failure')
  expect(res.error).toMatch(/cannot date/)
  expect(transfers).toHaveLength(0)
})
