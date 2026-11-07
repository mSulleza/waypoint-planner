import { useLocalSearchParams } from 'expo-router'
import { Suspense, useRef, type RefObject } from 'react'
import { useSnapshot } from '@/data/hooks'
import { loadAddForm } from '@/screens/add/load'
import { sheetWords } from '@/screens/add/sheet-words'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { RouteSheet } from '@/shell/RouteSheet'
import { Text } from '@/ui/Text'

const useAddForm = lazyPart<{ focus: RefObject<{ focus: () => void } | null> }>(
  () => loadAddForm().then((m) => m.AddForm),
  ({ retry }) => <NotLoaded what="The Add sheet" retry={retry} />,
)

// Record, Record payment, Record transfer, quick add and the next action all open this sheet; the address prefills it (mode, from, to, amount, plan_item_id, period).
export default function Add() {
  const focus = useRef<{ focus: () => void } | null>(null)
  const params = useLocalSearchParams<{ mode?: string; from?: string; to?: string; plan_item_id?: string }>()
  const { title } = sheetWords(useSnapshot().snapshot?.doc, params)
  const AddForm = useAddForm()
  return (
    <RouteSheet title={title} initialFocus={focus}>
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <AddForm focus={focus} />
      </Suspense>
    </RouteSheet>
  )
}
