import type { DeviceEvent, EventKind, ParamKey, RawSession } from '../types'
import { HZ, paramKey, sampleIdx } from '../types'

export type ParseOutcome = { sessions: RawSession[]; partial: boolean }

const EVENT_KINDS: readonly EventKind[] = [
  'PRESS_UP',
  'PRESS_DOWN',
  'APNEA',
  'SNORE',
  'HYP',
  'FH',
]

export function dateFromName(fileName: string): Date | null {
  const m = /^(\d{2})(\d{2})(\d{4})/.exec(fileName)
  if (!m) return null
  const dd = Number(m[1])
  const mm = Number(m[2])
  const yyyy = Number(m[3])
  const d = new Date(yyyy, mm - 1, dd, 12, 0, 0)
  if (d.getDate() !== dd || d.getMonth() !== mm - 1) return null
  return d
}

type Building = {
  start: Date
  offDate: [number, number, number] | null
  offTime: [number, number, number] | null
  params: Map<ParamKey, number>
  press: number[]
  flow: number[]
  events: DeviceEvent[]
  startPending: boolean // ON_DATE seen, ON_TIME may still arrive
}

export function parseDs1(buf: ArrayBuffer, fileName: string): ParseOutcome {
  const bytes = new Uint8Array(buf)
  const sessions: RawSession[] = []
  let cur: Building | null = null
  let partial = bytes.length % 4 !== 0
  let onDate: [number, number, number] | null = null

  const finish = (b: Building) => {
    if (b.press.length === 0) return
    const end =
      b.offDate && b.offTime
        ? new Date(
            2000 + b.offDate[0],
            b.offDate[1] - 1,
            b.offDate[2],
            b.offTime[0],
            b.offTime[1],
            b.offTime[2]
          )
        : new Date(b.start.getTime() + (b.press.length / HZ) * 1000)
    sessions.push({
      start: b.start,
      end,
      params: b.params,
      press: Uint16Array.from(b.press),
      flow: Uint16Array.from(b.flow),
      events: b.events,
    })
  }

  const open = (start: Date): Building => ({
    start,
    offDate: null,
    offTime: null,
    params: new Map(),
    press: [],
    flow: [],
    events: [],
    startPending: false,
  })

  const orphanSession = (): Building => {
    const d = dateFromName(fileName)
    if (!d) throw new Error(`cannot date file: ${fileName}`)
    return open(d)
  }

  const n = bytes.length - (bytes.length % 4)
  for (let i = 0; i < n; i += 4) {
    const b0 = bytes[i]!
    if ((b0 & 0x80) === 0) {
      // zero padding at sector tails is expected; anything else is corruption
      if (
        b0 !== 0 ||
        bytes[i + 1]! !== 0 ||
        bytes[i + 2]! !== 0 ||
        bytes[i + 3]! !== 0
      )
        partial = true
      continue
    }
    const type = (b0 & 0x78) >> 3
    const sub = b0 & 0x07
    const b1 = bytes[i + 1]!
    const b2 = bytes[i + 2]!
    const b3 = bytes[i + 3]!

    if (type === 0) {
      if (sub === 0) {
        if (cur) finish(cur)
        onDate = [b1, b2, b3]
        cur = open(new Date(2000 + b1, b2 - 1, b3, 12, 0, 0))
        cur.startPending = true
      } else if (!cur) {
        continue
      } else if (sub === 1 && cur.startPending && onDate) {
        cur.start = new Date(
          2000 + onDate[0],
          onDate[1] - 1,
          onDate[2],
          b1,
          b2,
          b3
        )
        cur.startPending = false
      } else if (sub === 2) {
        cur.offDate = [b1, b2, b3]
      } else if (sub === 3) {
        cur.offTime = [b1, b2, b3]
      }
    } else if (type === 1) {
      if (!cur) cur = orphanSession()
      cur.params.set(paramKey(b1), (b2 << 7) + b3)
    } else if (type === 2) {
      if (!cur) cur = orphanSession()
      cur.press.push(((b0 & 0x07) << 9) | (b1 << 2) | ((b2 & 0x60) >> 5))
      cur.flow.push(((b2 & 0x1f) << 7) + b3)
    } else if (type === 3) {
      if (!cur) cur = orphanSession()
      cur.events.push({
        index: sampleIdx(cur.press.length),
        kind: EVENT_KINDS[sub] ?? 'FH',
        d1: b1,
        d2: b2,
        d3: b3,
      })
    }
    // types 4-6 (CP/STATE/SPO): defined by the format, never written by the
    // DS-6; ignored.
  }
  if (cur) finish(cur)
  return { sessions, partial }
}
