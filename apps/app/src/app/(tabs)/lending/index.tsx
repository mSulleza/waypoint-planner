import { Suspense } from 'react'
import { loadLending } from '@/screens/lending/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

const useBody = lazyPart(
  () => loadLending().then((m) => m.LendingTab),
  ({ retry }) => <NotLoaded what="Lending" retry={retry} />,
)

// The lending book against the income it should replace; ?loss= and ?topup= hold the what-if choices.
export default function LendingRoute() {
  const Body = useBody()
  return (
    <Screen title="Lending" kind="tab">
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body />
      </Suspense>
    </Screen>
  )
}
