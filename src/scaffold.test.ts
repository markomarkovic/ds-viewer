import { expect, test } from 'vitest'

test('vitest runs TypeScript', () => {
  const brand = (n: number) => n as number & { readonly __brand: 'X' }
  expect(brand(2) + 1).toBe(3)
})
