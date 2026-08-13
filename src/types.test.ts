import { expect, test } from 'vitest'
import { FLOW_LPM, HZ, cmH2O, deci, lpm, WORKMODE } from './types'

test('constants', () => {
  expect(HZ).toBe(10)
  expect(FLOW_LPM).toBe(0.12)
})

test('unit conversions live in exactly one place', () => {
  expect(cmH2O(deci(64))).toBeCloseTo(6.4, 10)
  expect(lpm(100)).toBeCloseTo(12, 10)
})

test('work mode table is the DS-family mapping', () => {
  expect(WORKMODE[3]).toBe('AUTO')
  expect(WORKMODE[2]).toBe('CPAP')
  expect(WORKMODE[7]).toBe('APCV')
})
