import { Suspense } from 'react'
import { loadMonths } from '@/screens/months/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

// One lazy screen for every month and view, so a change draws at once.
const useBody = lazyPart(
  () => loadMonths().then((m) => m.Months),
  ({ retry }) => <NotLoaded what="Months" retry={retry} />,
)

export default function MonthsTab() {
  const Body = useBody()
  return (
    <Screen title="Months" kind="tab">
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body />
      </Suspense>
    </Screen>
  )
}
