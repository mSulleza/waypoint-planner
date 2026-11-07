import { useLocalSearchParams } from 'expo-router'
import { Suspense } from 'react'
import { useSnapshot } from '@/data/hooks'
import { loadPlan } from '@/screens/plan/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { NEW_ITEM_ID } from '@/shell/url.model'
import { Text } from '@/ui/Text'

const useBody = lazyPart<{ id: string }>(
  () => loadPlan().then((m) => m.PlanItemEditor),
  ({ retry }) => <NotLoaded what="The plan item editor" retry={retry} />,
)

// /plan/item/<id> edits an item; /plan/item/new adds one (Plan's Add an item), with ?kind= and ?category= to start it.
export default function PlanItem() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const item = useSnapshot().snapshot?.doc.plan_items.find((p) => p.id === id)
  const Body = useBody()
  return (
    <Screen title={item?.name ?? (id === NEW_ITEM_ID ? 'New plan item' : 'Plan item')} kind="page">
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body id={id} />
      </Suspense>
    </Screen>
  )
}
