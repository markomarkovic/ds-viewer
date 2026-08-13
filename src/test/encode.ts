export const rec = {
  onDate: (y2k: number, m: number, d: number) => [0x80, y2k, m, d],
  onTime: (h: number, mi: number, s: number) => [0x81, h, mi, s],
  offDate: (y2k: number, m: number, d: number) => [0x82, y2k, m, d],
  offTime: (h: number, mi: number, s: number) => [0x83, h, mi, s],
  param: (key: number, value: number) => [
    0x88,
    key,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ],
  sample: (pressDeci: number, flowCounts: number) => [
    0x90 | ((pressDeci >> 9) & 0x07),
    (pressDeci >> 2) & 0x7f,
    (((pressDeci & 0x03) << 5) | ((flowCounts >> 7) & 0x1f)) & 0x7f,
    flowCounts & 0x7f,
  ],
  event: (sub: number, d1: number, d2 = 0, d3 = 0) => [0x98 | sub, d1, d2, d3],
}

export function buildDs1(
  records: number[][],
  opts: { pad?: boolean } = {}
): ArrayBuffer {
  const flat = records.flat()
  const pad = opts.pad ?? true
  const len = pad ? Math.ceil(flat.length / 256) * 256 || 256 : flat.length
  const out = new Uint8Array(len)
  out.set(flat)
  return out.buffer
}

export function simpleNight(
  opts: {
    sampleCount?: number
    pressDeci?: number
    flowCounts?: number
    apneaAt?: number[]
  } = {}
): ArrayBuffer {
  const n = opts.sampleCount ?? 3000
  const press = opts.pressDeci ?? 64
  const flow = opts.flowCounts ?? 160
  const apneaAt = new Set(opts.apneaAt ?? [])
  const records: number[][] = [
    rec.onDate(26, 8, 13),
    rec.onTime(21, 30, 0),
    rec.param(0x04, 3), // WorkMode AUTO
    rec.param(0x06, 200), // MaxPress 20.0
    rec.param(0x07, 60), // MinPress 6.0
    rec.param(0x00, 5), // Ramp 5 min
    rec.param(0x01, 1), // Humidity 1
  ]
  for (let i = 0; i < n; i++) {
    if (apneaAt.has(i)) records.push(rec.event(2, 10))
    records.push(rec.sample(press, flow))
  }
  const durS = Math.floor(n / 10)
  const endH = 21 + Math.floor((30 * 60 + durS) / 3600)
  const endM = Math.floor(((30 * 60 + durS) % 3600) / 60)
  const endS = durS % 60
  records.push(rec.offDate(26, 8, 13), rec.offTime(endH, endM, endS))
  return buildDs1(records)
}
