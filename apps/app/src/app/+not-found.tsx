import { useRouter } from 'expo-router'
import type { Phase } from '@/data/status'
import { useSnapshot } from '@/data/hooks'
import { useDataSource } from '@/data/source'
import { gate, homeOf } from '@/shell/gate.model'
import { Screen } from '@/shell/Screen'
import { EmptyState } from '@/ui/EmptyState'

// Drawn whatever the account's state, as anyone can follow a broken link.
const EVERY_PHASE: readonly Phase[] = ['loading', 'ready', 'failed', 'signed_out', 'no_household']

// An address that is no page in Waypoint: say so, and offer the way in the gate has open.
export default function NotFound() {
  const router = useRouter()
  const { owner, source } = useDataSource()
  const { phase } = useSnapshot()
  const home = homeOf(gate({ owner, sample: source.kind === 'sample', phase }))
  const label = home === '/' ? 'Open Today' : home === '/onboarding' ? 'Open set-up' : 'Open Welcome'
  return (
    <Screen title="Not found" kind="page" onSettings phases={EVERY_PHASE} hideNotices={['signed_out', 'no_household']}>
      <EmptyState title="Nothing at this address" body="This link is not a page in Waypoint. It may be mistyped, or from an older version." action={{ label, onPress: () => router.replace(home) }} />
    </Screen>
  )
}
