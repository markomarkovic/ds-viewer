import type { ComponentChildren } from 'preact'

const TIP =
  'Estimated: reconstructed from the flow waveform by this viewer, not ' +
  'read from a decoded field.'

export function Estimated({ children }: { children: ComponentChildren }) {
  return (
    <span class="estimated" data-tooltip={TIP} data-placement="bottom">
      {children}
    </span>
  )
}
