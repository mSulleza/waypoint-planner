import { useLocalSearchParams } from 'expo-router'
import { Suspense } from 'react'
import { useSnapshot } from '@/data/hooks'
import { loadMoney } from '@/screens/money/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

const useBody = lazyPart<{ accountId: string }>(
  () => loadMoney().then((m) => m.Ledger),
  ({ retry }) => (
    <Screen title="Account" kind="page">
      <NotLoaded what="The ledger" retry={retry} />
    </Screen>
  ),
)

// One account's month: /money/<id>?month=YYYY-MM. The ledger draws its own Screen, whose rows are a virtualised list.
export default function AccountRoute() {
  const { accountId } = useLocalSearchParams<{ accountId: string }>()
  const name = useSnapshot().snapshot?.doc.accounts.find((a) => a.id === accountId)?.name ?? 'Account'
  const Body = useBody()
  return (
    <Suspense
      fallback={
        <Screen title={name} kind="page" accountId={accountId}>
          <Text tone="text2">Loading…</Text>
        </Screen>
      }
    >
      <Body accountId={accountId} />
    </Suspense>
  )
}
