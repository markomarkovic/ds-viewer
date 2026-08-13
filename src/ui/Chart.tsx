import type { JSX } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import type uPlot from 'uplot'

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
    return () => {
      window.removeEventListener('resize', onResize)
      plot.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return <div ref={ref} />
}
