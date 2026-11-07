import { Suspense } from 'react'
import { loadPlan } from '@/screens/plan/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

const useBody = lazyPart(
  () => loadPlan().then((m) => m.PlanTab),
  ({ retry }) => (
    <Screen title="Plan" kind="tab">
      <NotLoaded what="Plan" retry={retry} />
    </Screen>
  ),
)

// The Plan tab draws its own Screen, whose plan items are a virtualised list under the headline.
export default function PlanRoute() {
  const Body = useBody()
  return (
    <Suspense
      fallback={
        <Screen title="Plan" kind="tab">
          <Text tone="text2">Loading…</Text>
        </Screen>
      }
    >
      <Body />
    </Suspense>
  )
}
