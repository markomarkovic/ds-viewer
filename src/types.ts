export const HZ = 10
export const FLOW_LPM = 0.12

export type Brand<T, B extends string> = T & { readonly __brand: B }

export type Deci = Brand<number, 'Deci'> // 0.1 cmH2O, as stored on disk
export type CmH2O = Brand<number, 'CmH2O'> // display units
export type Counts = Brand<number, 'Counts'> // raw flow, as stored on disk
export type Lpm = Brand<number, 'Lpm'> // litres per minute
export type Ml = Brand<number, 'Ml'> // millilitres
export type SampleIdx = Brand<number, 'SampleIdx'> // 10 Hz index within a session
export type Seconds = Brand<number, 'Seconds'> // elapsed within a session/night
export type ParamKey = Brand<number, 'ParamKey'>

export const deci = (n: number): Deci => n as Deci
export const cmH2O = (d: Deci): CmH2O => (d / 10) as CmH2O
export const lpm = (counts: number): Lpm => (counts * FLOW_LPM) as Lpm
export const ml = (n: number): Ml => n as Ml
export const paramKey = (n: number): ParamKey => n as ParamKey
export const seconds = (n: number): Seconds => n as Seconds
export const sampleIdx = (n: number): SampleIdx => n as SampleIdx

export const PARAM = {
  RampTime: paramKey(0x00),
  HumidityLevel: paramKey(0x01),
  WorkMode: paramKey(0x04),
  MaxPress: paramKey(0x06),
  MinPress: paramKey(0x07),
} as const

// AnalysiHelper.GetModel, "DS" device family: switch (WorkMode - 2)
export const WORKMODE: Record<number, string> = {
  2: 'CPAP',
  3: 'AUTO',
  4: 'S',
  5: 'ST',
  6: 'T',
  7: 'APCV',
}

export type EventKind =
  'PRESS_UP' | 'PRESS_DOWN' | 'APNEA' | 'SNORE' | 'HYP' | 'FH'

export type DeviceEvent = {
  index: SampleIdx
  kind: EventKind
  d1: number
  d2: number
  d3: number
}

/** Parser output: no derived data yet. */
export type RawSession = {
  start: Date // device RTC, nominal
  end: Date
  params: Map<ParamKey, number>
  press: Uint16Array // Deci per element, 10 Hz
  flow: Uint16Array // Counts per element, 10 Hz
  events: DeviceEvent[]
}

export type Session = RawSession & {
  leak: Float32Array // Lpm per element, 1 Hz baseline
}

export type PressStats = {
  avg: Deci
  median: Deci
  p90: Deci
  p95: Deci
  max: Deci
}

export type BreathTable = {
  count: number
  // sample index into the zero-padded whole-night wall-clock timeline
  // (gap zeros included, not just concatenated session samples); a future
  // consumer needing per-session offsets (e.g. event scoring) must re-derive
  // them from session timestamps
  insp: Int32Array
  exp: Int32Array
  nextInsp: Int32Array
  tv: Int32Array // mL
  bpm: Float32Array // breaths/min
  leak: Float32Array // raw counts
}

export type BreathMetrics = {
  breaths: number // breaths after the 5-min trim
  expPress: { avg: Deci; min: Deci; p90: Deci; p95: Deci }
  inspPress: { avg: Deci; max: Deci; p90: Deci; p95: Deci }
  tv: { avg: Ml; p50: Ml; p90: Ml; p95: Ml }
  bpm: { avg: number; p50: number; p90: number; p95: number }
  ie: { avg: number; p50: number; p90: number; p95: number }
  mv: { avg: Ml; p50: Ml; p90: Ml; p95: Ml } // mL/min
  leak: { avg: Lpm; p50: Lpm; p90: Lpm; p95: Lpm }
}

export type Night = {
  name: string // filename stem
  date: Date // noon of the night's day
  sessions: Session[]
  hours: number
  samples: number
  press: PressStats
  histogram: Uint32Array // 301 bins, 0.1 cmH2O each
  leakMedian: Lpm
  events: { apnea: number; pressUp: number; pressDown: number }
  ahi: number
  partial: boolean
  breath: BreathMetrics | null // null when the 5-min trims leave no breaths
  breaths: BreathTable | null // retained for the event-scoring follow-on
}

export type WorkerRequest = { id: number; name: string; buf: ArrayBuffer }
export type WorkerResponse =
  | { id: number; name: string; ok: true; night: Night }
  | { id: number; name: string; ok: false; error: string }
