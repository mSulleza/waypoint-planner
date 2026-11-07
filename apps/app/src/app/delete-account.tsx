import { Suspense } from 'react'
import type { Notice, Phase } from '@/data/status'
import { loadSettings } from '@/screens/settings/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

// Open to everyone, so it draws whatever the account's state: signed out it signs in first, and an account without a household can go too.
const EVERY_PHASE: readonly Phase[] = ['loading', 'ready', 'failed', 'signed_out', 'no_household']

// The page says these itself, and a sample says nothing about the account being deleted.
const SAID_HERE: readonly Notice['id'][] = ['signed_out', 'no_household', 'sample', 'rates']

const useBody = lazyPart(
  () => loadSettings().then((m) => m.DeleteAccountBody),
  ({ retry }) => <NotLoaded what="This page" retry={retry} />,
)

export default function DeleteAccount() {
  const Body = useBody()
  return (
    <Screen title="Delete account" kind="page" onSettings phases={EVERY_PHASE} hideNotices={SAID_HERE}>
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body />
      </Suspense>
    </Screen>
  )
}
