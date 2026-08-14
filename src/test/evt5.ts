// Minimal reader for the vendor's .EVT5 event files (spec, "EVT5 file
// layout"): 4096-byte header, then 20-byte little-endian records. Mirrors
// ReloadEvents + FindEvents: all records in order, minus iValidation == 2.
// Test-only — never imported by shipped code.
export type Evt5Event = {
  order: number
  startMs: number
  lenMs: number
  type: number
  validation: number
  blockId: number
}

export function readEvt5(buf: ArrayBuffer): Evt5Event[] {
  const dv = new DataView(buf)
  const out: Evt5Event[] = []
  for (let off = 4096; off + 20 <= buf.byteLength; off += 20) {
    const e = {
      order: dv.getUint16(off, true),
      startMs: Number(dv.getBigInt64(off + 2, true)),
      lenMs: dv.getInt32(off + 10, true),
      type: dv.getUint8(off + 14),
      validation: dv.getUint8(off + 15),
      blockId: dv.getUint16(off + 16, true),
    }
    if (e.validation !== 2) out.push(e)
  }
  return out
}
