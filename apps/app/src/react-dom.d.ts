// react-dom ships no types here; the print page needs only createPortal.
declare module 'react-dom' {
  import type { ReactNode, ReactPortal } from 'react'
  export function createPortal(children: ReactNode, container: Element | DocumentFragment, key?: string | null): ReactPortal
}
