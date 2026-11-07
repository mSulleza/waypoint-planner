import { Suspense } from 'react'
import { loadImport } from '@/screens/import/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

const useBody = lazyPart(
  () => loadImport().then((m) => m.ImportFlow),
  ({ retry }) => (
    <Screen title="Import" kind="page">
      <NotLoaded what="Import" retry={retry} />
    </Screen>
  ),
)

// /import?account=<id>: a bank's CSV file into one account. The flow draws its own Screen, whose review rows are a virtualised list.
export default function Import() {
  const Body = useBody()
  return (
    <Suspense
      fallback={
        <Screen title="Import" kind="page">
          <Text tone="text2">Loading…</Text>
        </Screen>
      }
    >
      <Body />
    </Suspense>
  )
}
