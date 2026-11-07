import { useRouter } from 'expo-router'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode, type RefObject } from 'react'
import { useSnapshot } from '@/data/hooks'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { PageTitle } from './Screen'

const CloseSheet = createContext<() => void>(() => undefined)
const SheetTop = createContext<() => void>(() => undefined)

// Closes the sheet route the content sits in, through the exit animation and then Back, as the Close button does.
export function useCloseSheet(): () => void {
  return useContext(CloseSheet)
}

// Scrolls the sheet back to its top, where a refusal about the first field shows.
export function useSheetTop(): () => void {
  return useContext(SheetTop)
}

// A modal route (add, statement, reconcile) drawn as the kit's sheet over the screen it opened from; closing it steps Back.
export function RouteSheet({ title, children, initialFocus }: { title: string; children?: ReactNode; initialFocus?: RefObject<{ focus: () => void } | null> }) {
  const router = useRouter()
  const { phase, loading } = useSnapshot()
  const [open, setOpen] = useState(false)
  const [top, setTop] = useState(0)
  useEffect(() => setOpen(true), [])
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'))
  const close = () => setOpen(false)
  const toTop = useCallback(() => setTop((n) => n + 1), [])
  return (
    <>
      <PageTitle title={title} />
      <Sheet open={open} onClose={close} onExited={leave} title={title} initialFocus={initialFocus} scrollKey={top}>
        <SheetTop value={toTop}>
          <CloseSheet value={close}>{phase === 'ready' ? children : null}</CloseSheet>
        </SheetTop>
        {loading ? <Text tone="text2">Loading…</Text> : null}
      </Sheet>
    </>
  )
}
