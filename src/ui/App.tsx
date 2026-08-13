import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks'
import ParseWorker from '../parse/worker?worker&inline'
import { filesFromDataTransfer, gather } from '../load/dropzone'
import { initialState, reducer, visibleNights } from '../state'
import type { WorkerResponse } from '../types'
import { cmH2O } from '../types'
import { NightDetail, NightHeader } from './NightDetail'
import { NightTable } from './NightTable'
import { RangeSelector } from './RangeSelector'
import { Summary } from './Summary'
import { TrendChart } from './TrendChart'

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const workerRef = useRef<Worker | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const nextId = useRef(1)

  // Info notices dismiss themselves after 5 s; errors stay until dismissed.
  const autoDismissed = useRef(new Set<number>())
  useEffect(() => {
    for (const n of state.notices) {
      if (n.kind !== 'info' || autoDismissed.current.has(n.id)) continue
      autoDismissed.current.add(n.id)
      setTimeout(() => dispatch({ type: 'dismiss-notice', id: n.id }), 5000)
    }
  }, [state.notices])

  useEffect(() => {
    const w = new ParseWorker()
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const res = e.data
      if (res.ok) dispatch({ type: 'night-loaded', night: res.night })
      else dispatch({ type: 'file-failed', name: res.name, error: res.error })
    }
    workerRef.current = w
    return () => w.terminate()
  }, [])

  const ingest = async (files: File[]) => {
    const { accepted, refused, skippedCount } = gather(files)
    dispatch({
      type: 'ingest-started',
      accepted: accepted.length,
      skippedCount,
      refused,
    })
    for (const f of accepted) {
      const buf = await f.arrayBuffer()
      workerRef.current?.postMessage(
        { id: nextId.current++, name: f.name, buf },
        [buf]
      )
    }
  }

  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (e.dataTransfer)
        void filesFromDataTransfer(e.dataTransfer.items).then(ingest)
    }
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      setDragOver(true)
    }
    const onDragLeave = () => setDragOver(false)
    document.addEventListener('drop', onDrop)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    return () => {
      document.removeEventListener('drop', onDrop)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
    }
  }, [])

  // The open night lives in the URL hash, so browser back/forward work.
  // The reducer's `selected` only mirrors it.
  useEffect(() => {
    const applyHash = () =>
      dispatch({
        type: 'select-night',
        name:
          location.hash.length > 1
            ? decodeURIComponent(location.hash.slice(1))
            : null,
      })
    applyHash()
    window.addEventListener('hashchange', applyHash)
    return () => window.removeEventListener('hashchange', applyHash)
  }, [])

  const visible = useMemo(() => visibleNights(state), [state])
  const selectedNight = state.selected
    ? state.nights.find((n) => n.name === state.selected)
    : undefined

  return (
    <>
      <header class="container">
        {selectedNight ? (
          <NightHeader
            night={selectedNight}
            onBack={() => (location.hash = '')}
          />
        ) : (
          <FilePickers
            onFiles={ingest}
            pending={state.pending}
            nights={state.nights.length}
          />
        )}
      </header>
      <main class="container">
        {state.notices.map((n) => (
          <article key={n.id} role="alert" class="notice">
            <span>{n.text}</span>
            <button
              class="notice-close"
              aria-label="dismiss"
              onClick={() => dispatch({ type: 'dismiss-notice', id: n.id })}
            >
              ×
            </button>
          </article>
        ))}
        {state.nights.length === 0 && state.pending === 0 ? (
          <article class={dragOver ? 'dropzone drag-over' : 'dropzone'}>
            <h2>Drop .ds1 files or a folder here</h2>
            <p>Nothing is uploaded — parsing happens entirely in this page.</p>
          </article>
        ) : selectedNight ? (
          <NightDetail night={selectedNight} />
        ) : (
          <>
            <Summary nights={visible} />
            <RangeSelector
              nights={state.nights}
              range={state.range}
              onRange={(range) => dispatch({ type: 'set-range', range })}
            />
            <TrendChart
              title="duration (h)"
              nights={visible}
              value={(n) => n.hours}
              color="#4c9a52"
            />
            <TrendChart
              title="P95 (cmH2O)"
              nights={visible}
              value={(n) => cmH2O(n.press.p95)}
              color="#3a7ca5"
            />
            <TrendChart
              title="AHI"
              nights={visible}
              value={(n) => n.ahi}
              color="#a54c3a"
            />
            <TrendChart
              title="median leak (L/min)"
              nights={visible}
              value={(n) => n.leakMedian}
              color="#8a6d3b"
            />
            <NightTable
              nights={visible}
              onSelect={(name) => (location.hash = encodeURIComponent(name))}
            />
          </>
        )}
        <footer>
          <small>
            <a href="https://github.com/markomarkovic/ds-viewer">
              v{__APP_VERSION__}
            </a>{' '}
            · {__GIT_COMMIT__} · timestamps are device-clock and nominal;
            durations are exact
          </small>
        </footer>
      </main>
    </>
  )
}

function FilePickers({
  onFiles,
  pending,
  nights,
}: {
  onFiles: (files: File[]) => void
  pending: number
  nights: number
}) {
  const pick = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    if (input.files) onFiles(Array.from(input.files))
    input.value = ''
  }
  return (
    <nav>
      <ul>
        <li>
          <hgroup>
            <h3>ds-viewer</h3>
            <p>
              {nights > 0 || pending > 0 ? (
                <>
                  {nights > 0 && `${nights} nights loaded`}
                  {pending > 0 && ` · parsing ${pending}…`}
                </>
              ) : (
                'in-browser viewer for DreamSleep .ds1 CPAP logs'
              )}
            </p>
          </hgroup>
        </li>
      </ul>
      <ul>
        <li>
          <div role="group">
            <label role="button" class="secondary">
              + files
              <input
                type="file"
                multiple
                accept=".ds1"
                hidden
                onChange={pick}
              />
            </label>
            <label role="button" class="secondary">
              + folder
              {/* webkitdirectory is non-standard but universal */}
              <input
                type="file"
                hidden
                {...{ webkitdirectory: true }}
                onChange={pick}
              />
            </label>
          </div>
        </li>
      </ul>
    </nav>
  )
}
