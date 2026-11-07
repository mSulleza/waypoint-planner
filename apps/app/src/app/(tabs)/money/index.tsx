import { Suspense } from 'react'
import { loadMoney } from '@/screens/money/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

const useBody = lazyPart(
  () => loadMoney().then((m) => m.MoneyTab),
  ({ retry }) => <NotLoaded what="Money" retry={retry} />,
)

export default function MoneyRoute() {
  const Body = useBody()
  return (
    <Screen title="Money" kind="tab">
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body />
      </Suspense>
    </Screen>
  )
}
