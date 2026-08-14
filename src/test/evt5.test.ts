import { expect, test } from 'vitest'
import { readEvt5 } from './evt5'

function rec(
  dv: DataView,
  off: number,
  e: {
    order: number
    startMs: number
    lenMs: number
    type: number
    validation: number
    blockId: number
  }
): void {
  dv.setUint16(off, e.order, true)
  dv.setBigInt64(off + 2, BigInt(e.startMs), true)
  dv.setInt32(off + 10, e.lenMs, true)
  dv.setUint8(off + 14, e.type)
  dv.setUint8(off + 15, e.validation)
  dv.setUint16(off + 16, e.blockId, true)
}

test('readEvt5 decodes records after the 4096-byte header, dropping validation=2', () => {
  const buf = new ArrayBuffer(4096 + 60)
  const dv = new DataView(buf)
  rec(dv, 4096, {
    order: 0,
    startMs: 774200,
    lenMs: 14200,
    type: 0x15,
    validation: 0,
    blockId: 1,
  })
  rec(dv, 4116, {
    order: 1,
    startMs: 900000,
    lenMs: 10000,
    type: 0x17,
    validation: 2,
    blockId: 0,
  })
  rec(dv, 4136, {
    order: 2,
    startMs: 1200000,
    lenMs: 12000,
    type: 0x16,
    validation: 0,
    blockId: 1,
  })
  const evs = readEvt5(buf)
  expect(evs).toHaveLength(2)
  expect(evs[0]).toEqual({
    order: 0,
    startMs: 774200,
    lenMs: 14200,
    type: 0x15,
    validation: 0,
    blockId: 1,
  })
  expect(evs[1]!.type).toBe(0x16)
  expect(readEvt5(new ArrayBuffer(4096))).toHaveLength(0)
})
