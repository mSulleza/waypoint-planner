import { useLocalSearchParams } from 'expo-router'
import { Suspense } from 'react'
import { useSnapshot } from '@/data/hooks'
import { loadSettings } from '@/screens/settings/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { NEW_ACCOUNT_ID } from '@/shell/url.model'
import { Text } from '@/ui/Text'

const useBody = lazyPart<{ id: string }>(
  () => loadSettings().then((m) => m.AccountEditor),
  ({ retry }) => <NotLoaded what="The account editor" retry={retry} />,
)

// /settings/account/<id> edits an account; /settings/account/new adds one (Settings' Add an account, Debts' Add a debt), with ?kind= to start it.
export default function AccountSettings() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const account = useSnapshot().snapshot?.doc.accounts.find((a) => a.id === id)
  const Body = useBody()
  return (
    <Screen title={account?.name ?? (id === NEW_ACCOUNT_ID ? 'New account' : 'Account')} kind="page" onSettings>
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body id={id} />
      </Suspense>
    </Screen>
  )
}
