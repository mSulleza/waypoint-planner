import { Suspense } from 'react'
import { loadMeals } from '@/screens/meals/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

const useBody = lazyPart(
  () => loadMeals().then((m) => m.MealsBody),
  ({ retry }) => <NotLoaded what="Meals" retry={retry} />,
)

// The week's cooking from the shopping day, and its shopping against the meals allowance; ?week= names a day of the week shown.
export default function MealsTab() {
  const Body = useBody()
  return (
    <Screen title="Meals" kind="tab">
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body />
      </Suspense>
    </Screen>
  )
}
