// Compile-time-only assertions that the brands are mutually unassignable.
// This file must always typecheck; the @ts-expect-error lines fail the build
// if the brands ever collapse into plain number.
import type { CmH2O, Deci, Lpm, Ml, Seconds } from './types'

declare const d: Deci
declare const c: CmH2O
declare const l: Lpm
declare const m: Ml
declare const s: Seconds

// @ts-expect-error Deci is not CmH2O
const bad1: CmH2O = d
// @ts-expect-error CmH2O is not Deci
const bad2: Deci = c
// @ts-expect-error Lpm is not Seconds
const bad3: Seconds = l
// @ts-expect-error Ml is not Lpm
const bad5: Lpm = m
// @ts-expect-error plain number is not branded
const bad4: Deci = 64

export type _keep = [
  typeof bad1,
  typeof bad2,
  typeof bad3,
  typeof bad4,
  typeof bad5,
  typeof s,
]
