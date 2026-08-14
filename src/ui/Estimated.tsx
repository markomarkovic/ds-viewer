import type { ComponentChildren } from 'preact'

const TIP =
  'Estimated: computed by this viewer from the recorded signals, not ' +
  'read from a decoded field.'

export function Estimated({ children }: { children: ComponentChildren }) {
  return (
    <span class="estimated" data-tooltip={TIP} data-placement="bottom">
      {children}
    </span>
  )
}
