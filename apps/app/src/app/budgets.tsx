import { Suspense } from 'react'
import { loadBudgets } from '@/screens/budgets/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

const useBody = lazyPart(
  () => loadBudgets().then((m) => m.BudgetsBody),
  ({ retry }) => <NotLoaded what="Budgets" retry={retry} />,
)

// Every budget this week and month, opened from Today's All budgets.
export default function Budgets() {
  const Body = useBody()
  return (
    <Screen title="Budgets" kind="page">
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body />
      </Suspense>
    </Screen>
  )
}
