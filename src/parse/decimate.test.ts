import { expect, test } from 'vitest'
import { minmaxEnvelope } from './decimate'

test('identity when the window fits the width', () => {
  const { min, max } = minmaxEnvelope([5, 3, 8, 1], 0, 4, 10)
  expect(Array.from(min)).toEqual([5, 3, 8, 1])
  expect(Array.from(max)).toEqual([5, 3, 8, 1])
})

test('hand-computed buckets', () => {
  // 8 samples into 2 buckets of 4
  const data = [1, 9, 2, 8, 3, 7, 4, 6]
  const { min, max } = minmaxEnvelope(data, 0, 8, 2)
  expect(Array.from(min)).toEqual([1, 3])
  expect(Array.from(max)).toEqual([9, 7])
})

test('sub-range decimation', () => {
  const data = [0, 0, 10, 20, 30, 40, 0, 0]
  const { min, max } = minmaxEnvelope(data, 2, 6, 2)
  expect(Array.from(min)).toEqual([10, 30])
  expect(Array.from(max)).toEqual([20, 40])
})

test('invariants: envelope contains true extrema, output length == width', () => {
  let seed = 7
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  const data = Float64Array.from({ length: 10000 }, () => rnd() * 400)
  const { min, max } = minmaxEnvelope(data, 0, data.length, 137)
  expect(min).toHaveLength(137)
  expect(max).toHaveLength(137)
  let trueMin = Infinity
  let trueMax = -Infinity
  for (const v of data) {
    if (v < trueMin) trueMin = v
    if (v > trueMax) trueMax = v
  }
  expect(Math.min(...min)).toBe(trueMin)
  expect(Math.max(...max)).toBe(trueMax)
  for (let i = 0; i < 137; i++) expect(min[i]!).toBeLessThanOrEqual(max[i]!)
})
