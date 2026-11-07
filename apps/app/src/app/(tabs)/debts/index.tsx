import { Suspense } from 'react'
import { loadDebts } from '@/screens/debts/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

const useBody = lazyPart(
  () => loadDebts().then((m) => m.DebtsTab),
  ({ retry }) => <NotLoaded what="Debts" retry={retry} />,
)

export default function DebtsRoute() {
  const Body = useBody()
  return (
    <Screen title="Debts" kind="tab">
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body />
      </Suspense>
    </Screen>
  )
}
