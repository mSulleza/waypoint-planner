import { Suspense } from 'react'
import { useWindowDimensions } from 'react-native'
import { loadCompare } from '@/screens/compare/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { SIDEBAR_MIN_WIDTH } from '@/shell/shell.model'
import { Text } from '@/ui/Text'

const useBody = lazyPart(
  () => loadCompare().then((m) => m.CompareBody),
  ({ retry }) => <NotLoaded what="Compare" retry={retry} />,
)

// The levers ride in the fragment (#l=…): the browser's hash on the web and the same route param on phones, never sent to a server. From 1,024 px the page widens for its table.
export default function Compare() {
  const wide = useWindowDimensions().width >= SIDEBAR_MIN_WIDTH
  const Body = useBody()
  return (
    <Screen title="Compare" kind="page" wide={wide}>
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body />
      </Suspense>
    </Screen>
  )
}
