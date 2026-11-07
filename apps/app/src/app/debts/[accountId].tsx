import { useLocalSearchParams } from 'expo-router'
import { Suspense } from 'react'
import { useSnapshot } from '@/data/hooks'
import { loadDebts } from '@/screens/debts/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

const useBody = lazyPart<{ accountId: string }>(
  () => loadDebts().then((m) => m.DebtDetail),
  ({ retry }) => <NotLoaded what="This debt" retry={retry} />,
)

// One card or loan: /debts/<id>.
export default function DebtRoute() {
  const { accountId } = useLocalSearchParams<{ accountId: string }>()
  const debt = useSnapshot().snapshot?.doc.accounts.find((a) => a.id === accountId && a.kind !== 'cash')
  const Body = useBody()
  return (
    <Screen title={debt?.name ?? 'Debt'} kind="page" accountId={debt?.id}>
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body accountId={accountId} />
      </Suspense>
    </Screen>
  )
}
