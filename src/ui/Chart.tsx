import type { JSX } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type uPlot from 'uplot'

/**
 * Axis colors matching the active Pico theme. uPlot paints axis text and
 * grid on canvas, so CSS cannot reach them — every chart spreads this into
 * each of its axes, and Chart rebuilds on theme change so the values are
 * re-read.
 */
export function axisTheme(): uPlot.Axis {
  const s = getComputedStyle(document.documentElement)
  const text = s.getPropertyValue('--pico-color').trim() || '#333'
  const grid = s.getPropertyValue('--pico-muted-border-color').trim() || '#8884'
  return { stroke: text, grid: { stroke: grid }, ticks: { stroke: grid } }
}

/**
 * Shared cursor sync for every chart whose x axis is seconds-since-noon.
 * Syncing by scale value (not position) keeps charts aligned even when
 * their x ranges differ — the full-night overview and a 30 s waveform
 * window highlight the same instant.
 */
export const nightCursorSync: uPlot.Cursor.Sync = {
  key: 'night-x',
  scales: ['x', null],
}

/** Same idea for the list page, where x is calendar time. */
export const dateCursorSync: uPlot.Cursor.Sync = {
  key: 'date-x',
  scales: ['x', null],
}

/**
 * Locale-aware values for a calendar x axis. uPlot's built-in formatter
 * is fixed English (and 12-hour); this follows the browser's locale for
 * dates and always uses 24-hour time. Day-or-coarser splits get a
 * day-month label; sub-day splits get HH:MM, with midnight showing the
 * date instead.
 */
const dayMonth = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
})
const time24 = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function localDateValues(
  _u: uPlot,
  splits: number[]
): (string | number)[] {
  const step = splits.length > 1 ? (splits[1] ?? 0) - (splits[0] ?? 0) : 86400
  return splits.map((s) => {
    const d = new Date(s * 1000)
    if (step >= 86400) return dayMonth.format(d)
    const midnight = d.getHours() === 0 && d.getMinutes() === 0
    return midnight ? dayMonth.format(d) : time24.format(d)
  })
}

/**
 * Floating cursor tooltip. The formatter returns the tooltip text for the
 * hovered index (newlines allowed), or null to hide it. Positioned inside
 * u.over, flipping sides at the plot's midpoint so it never clips.
 */
export function tooltipPlugin(
  fmt: (u: uPlot, idx: number) => string | null
): uPlot.Plugin {
  let el: HTMLDivElement | null = null
  return {
    hooks: {
      init: (u) => {
        el = document.createElement('div')
        el.className = 'u-tooltip'
        u.over.appendChild(el)
        u.over.addEventListener('mouseleave', () => {
          if (el) el.style.display = 'none'
        })
      },
      setCursor: (u) => {
        if (!el) return
        const { left, top, idx } = u.cursor
        if (idx == null || left == null || left < 0) {
          el.style.display = 'none'
          return
        }
        const text = fmt(u, idx)
        if (!text) {
          el.style.display = 'none'
          return
        }
        el.textContent = text
        el.style.display = 'block'
        const w = u.over.clientWidth
        if (left > w / 2) {
          el.style.left = 'auto'
          el.style.right = `${w - left + 10}px`
        } else {
          el.style.right = 'auto'
          el.style.left = `${left + 10}px`
        }
        el.style.top = `${Math.max(0, (top ?? 0) - 30)}px`
      },
    },
  }
}

export function Chart({
  build,
  deps,
}: {
  build: (el: HTMLElement, width: number) => uPlot
  deps: readonly unknown[]
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Rebuilding a chart empties its container, and a freshly built uPlot
  // only reaches its full height a frame later. Either way the document
  // gets shorter, the browser clamps the scroll position to the shorter
  // page, and restoring the height does not scroll back — which is why
  // paging the waveform used to walk the view up the page. Holding the
  // last settled height as a floor keeps the document from ever shrinking.
  const floor = useRef(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (floor.current) el.style.minHeight = `${floor.current}px`
    const remeasure = () => {
      el.style.minHeight = ''
      floor.current = el.offsetHeight
      el.style.minHeight = `${floor.current}px`
    }
    let plot = build(el, el.clientWidth)
    let raf = requestAnimationFrame(remeasure)
    const onResize = () => {
      plot.destroy()
      plot = build(el, el.clientWidth)
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(remeasure)
    }
    window.addEventListener('resize', onResize)
    // Rebuild on theme flips so canvas-painted colors follow the new theme
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      mq.removeEventListener('change', onResize)
      plot.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return <div ref={ref} />
}
