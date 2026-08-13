import { expect, test } from 'vitest'
import { dateInputToMs, msToDateInput } from './RangeSelector'

test("to-input set to a night's own date includes local-noon of that date", () => {
  const noon = new Date(2026, 6, 1, 12, 0, 0).getTime() // local noon, Jul 1 2026
  const to = dateInputToMs('2026-07-01', 'to')
  expect(to).not.toBeNull()
  expect(noon).toBeLessThanOrEqual(to!)
})

test('from-input set to same date includes it', () => {
  const noon = new Date(2026, 6, 1, 12, 0, 0).getTime() // local noon, Jul 1 2026
  const from = dateInputToMs('2026-07-01', 'from')
  expect(from).not.toBeNull()
  expect(noon).toBeGreaterThanOrEqual(from!)
})

test('round-trip: msToDateInput(dateInputToMs(v, "from")) === v', () => {
  const v = '2026-07-01'
  expect(msToDateInput(dateInputToMs(v, 'from'))).toBe(v)
})

test('round-trip: msToDateInput(dateInputToMs(v, "to")) === v', () => {
  const v = '2026-07-01'
  expect(msToDateInput(dateInputToMs(v, 'to'))).toBe(v)
})

test('empty input maps to null both ways', () => {
  expect(dateInputToMs('', 'from')).toBeNull()
  expect(msToDateInput(null)).toBe('')
})
