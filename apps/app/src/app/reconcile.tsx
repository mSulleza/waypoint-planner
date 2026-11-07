import { Suspense, useRef, type RefObject } from 'react'
import { loadMoney } from '@/screens/money/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { RouteSheet } from '@/shell/RouteSheet'
import { Text } from '@/ui/Text'

const useBody = lazyPart<{ focus: RefObject<{ focus: () => void } | null> }>(
  () => loadMoney().then((m) => m.ReconcileForm),
  ({ retry }) => <NotLoaded what="Reconcile" retry={retry} />,
)

// /reconcile?account=<id>: the bank's figure against the ledger to today; a row is added only by a button.
export default function Reconcile() {
  const focus = useRef<{ focus: () => void } | null>(null)
  const Body = useBody()
  return (
    <RouteSheet title="Reconcile" initialFocus={focus}>
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body focus={focus} />
      </Suspense>
    </RouteSheet>
  )
}
