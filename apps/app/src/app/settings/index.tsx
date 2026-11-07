import { Suspense } from 'react'
import { loadSettings } from '@/screens/settings/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

const useBody = lazyPart(
  () => loadSettings().then((m) => m.SettingsBody),
  ({ retry }) => <NotLoaded what="Settings" retry={retry} />,
)

export default function Settings() {
  const Body = useBody()
  return (
    <Screen title="Settings" kind="page" onSettings>
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body />
      </Suspense>
    </Screen>
  )
}
