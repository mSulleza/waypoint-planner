import { Suspense, useRef, type RefObject } from 'react'
import { loadStatement } from '@/screens/statement/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { RouteSheet } from '@/shell/RouteSheet'
import { Text } from '@/ui/Text'

const useBody = lazyPart<{ focus: RefObject<{ focus: () => void } | null> }>(
  () => loadStatement().then((m) => m.StatementForm),
  ({ retry }) => <NotLoaded what="The Statement sheet" retry={retry} />,
)

// /statement?account=<card>: the printed statement, or its total and minimum only, checked until it balances; &statement=<id> edits a saved one.
export default function Statement() {
  const focus = useRef<{ focus: () => void } | null>(null)
  const Body = useBody()
  return (
    <RouteSheet title="Statement" initialFocus={focus}>
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body focus={focus} />
      </Suspense>
    </RouteSheet>
  )
}
