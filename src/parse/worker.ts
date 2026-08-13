import type { WorkerRequest, WorkerResponse } from '../types'
import { parseDs1 } from './ds1'
import { buildNight } from './metrics'

export function handle(req: WorkerRequest): {
  res: WorkerResponse
  transfers: Transferable[]
} {
  try {
    const stem = req.name.replace(/\.[^.]+$/, '')
    const { sessions, partial } = parseDs1(req.buf, req.name)
    const night = buildNight(stem, sessions, partial)
    const transfers: Transferable[] = []
    for (const s of night.sessions)
      transfers.push(s.press.buffer, s.flow.buffer, s.leak.buffer)
    return { res: { id: req.id, name: req.name, ok: true, night }, transfers }
  } catch (e) {
    return {
      res: {
        id: req.id,
        name: req.name,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
      transfers: [],
    }
  }
}

// Worker-context glue. Under Node/Vitest `self` is undefined; on the browser
// main thread `window` is defined. Only inside a worker is the guard true, so
// tests never execute this. The cast escapes the DOM-lib typing of `self`.
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  const ctx = self as unknown as {
    onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
    postMessage(msg: WorkerResponse, transfer: Transferable[]): void
  }
  ctx.onmessage = (e) => {
    const { res, transfers } = handle(e.data)
    ctx.postMessage(res, transfers)
  }
}
