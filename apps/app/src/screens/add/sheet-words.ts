export interface SheetWords {
  title: string
  // The Save button's label while the sheet is on the mode it opened in.
  save: string
}

type Opened = Partial<Record<'mode' | 'from' | 'to' | 'plan_item_id', string>>

interface Named {
  accounts: readonly { id: string; kind: string; name: string }[]
  plan_items: readonly { id: string; name: string }[]
}

// The Add sheet is named for the task it opened for, so the words the person tapped carry through; only + opens a plain Add.
export function sheetWords(doc: Named | undefined, params: Opened): SheetWords {
  const item = params.plan_item_id ? doc?.plan_items.find((p) => p.id === params.plan_item_id) : undefined
  if (item) return { title: `Record ${item.name}`, save: 'Save' }
  const to = params.mode === 'move' && params.to ? doc?.accounts.find((a) => a.id === params.to) : undefined
  if (to && to.kind !== 'cash') return { title: `Record payment to ${to.name}`, save: 'Save payment' }
  if (to && params.from) return { title: 'Record transfer', save: 'Save transfer' }
  return { title: 'Add', save: 'Save' }
}
