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

export function Chart({
  build,
  deps,
}: {
  build: (el: HTMLElement, width: number) => uPlot
  deps: readonly unknown[]
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let plot = build(el, el.clientWidth)
    const onResize = () => {
      plot.destroy()
      plot = build(el, el.clientWidth)
    }
    window.addEventListener('resize', onResize)
    // Rebuild on theme flips so canvas-painted colors follow the new theme
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      mq.removeEventListener('change', onResize)
      plot.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return <div ref={ref} />
}
