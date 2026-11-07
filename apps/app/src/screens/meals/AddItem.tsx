import { parseAmount, type Snapshot } from '@waypoint/core'
import { ITEM_KINDS, type Item, type ItemKind, type MealsDoc, type MealSettings, type Unit } from '@waypoint/core/meals'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Linking, Platform, View, type TextInput } from 'react-native'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { amountText } from '@/data/field-text'
import { randomId } from '@/data/uuid'
import type { Product } from '@/server/mercadona'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Choices } from '@/ui/Choices'
import { useMoneyText } from '@/ui/Money'
import { Segmented } from '@/ui/Segmented'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { TextField } from '@/ui/TextField'
import { useLocale } from '@/ui/theme'
import { SPACE } from '@/ui/tokens'
import { searchMercadona, useMealEdit } from './data'
import { KIND_WORDS } from './Items'
import { dayName, mercadonaLink, starterCategories } from './meals.model'
import { STRONG } from './parts'
import { fold, linkedItem, matchItems, productDraft, productWords } from './shop.model'

// A new item's starting values: from a Mercadona product, or typed in with a pack of one.
interface NewItem {
  name: string
  kind: ItemKind
  unit: Unit
  pack_size: number
  price_minor: number | null
  mercadona_id: string | null
  aisle: string | null
  category_id: string | null
  product: Product | null
}

type Step = { kind: 'new'; item: NewItem } | { kind: 'linked'; item: Item; product: Product }

const SEARCH_MS = 400
const HOUR = 60 * 60 * 1000

// The typed words once typing pauses, so the shop is searched once per word, not per letter.
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

interface AddItemProps {
  open: boolean
  doc: MealsDoc
  settings: MealSettings
  snapshot: Snapshot
  trips: readonly string[]
  onClose: () => void
}

// Puts any item on a trip until it is bought, such as eggs that ran out early; one not on the price list yet comes from Mercadona or is typed in.
export function AddItem({ open, doc, settings, snapshot, trips, onClose }: AddItemProps) {
  const locale = useLocale()
  const money = useMoneyText()
  const edit = useMealEdit()
  const search = useRef<TextInput>(null)
  const [query, setQuery] = useState('')
  const [item, setItem] = useState<string | null>(null)
  const [trip, setTrip] = useState<string>(trips[0] ?? '')
  const [asked, setAsked] = useState(false)
  const [product, setProduct] = useState<string | null>(null)
  const [step, setStep] = useState<Step | null>(null)
  const typed = useSettled(query.trim(), SEARCH_MS)
  const matches = useMemo(() => matchItems(doc.items, query, locale), [doc.items, query, locale])
  const none = useMemo(() => matchItems(doc.items, typed, locale).length === 0, [doc.items, typed, locale])
  // The shop is searched when no saved item matches, or when asked for.
  const searchShop = open && typed.length >= 2 && (asked || none)
  const shop = useQuery({ queryKey: ['mercadona', fold(typed)], queryFn: () => searchMercadona(typed), enabled: searchShop, staleTime: HOUR, retry: false })
  const picked = item !== null && matches.some((i) => i.id === item) ? item : null
  const words = query.trim()
  const want = asked || matches.length === 0
  // Until typing settles, the last search's results are for other words.
  const searching = want && (typed !== words || shop.isFetching)
  const failure = edit.error ? asDataError(edit.error) : null

  const close = () => {
    setQuery('')
    setItem(null)
    setAsked(false)
    setProduct(null)
    setStep(null)
    edit.reset()
    onClose()
  }
  const add = async (id: string) => {
    try {
      await edit.mutateAsync({ kind: 'item_patch', id, patch: { wanted_on: trip } })
      close()
    } catch {
      // The banner says what went wrong.
    }
  }
  const choose = (id: string) => {
    const p = shop.data?.find((x) => x.id === id)
    if (!p) return
    const linked = linkedItem(doc.items, p)
    if (linked) return setStep({ kind: 'linked', item: linked, product: p })
    const d = productDraft(p)
    const budgets = starterCategories(snapshot, settings.category_id)
    const category_id = d.budget === 'cleaning' ? budgets.cleaning : d.budget === 'personal care' ? budgets.care : null
    // Mercadona's prices are in euros; a household priced in another currency types its own.
    setStep({ kind: 'new', item: { ...d, price_minor: settings.currency === 'EUR' ? d.price_minor : null, category_id, product: p } })
  }
  const byHand = () => setStep({ kind: 'new', item: { name: words.slice(0, 60), kind: 'stock', unit: 'unit', pack_size: 1, price_minor: null, mercadona_id: null, aisle: null, category_id: null, product: null } })
  const shopMoney = (minor: number) => money(minor, 'EUR')
  const from = trip ? dayName(trip, locale) : 'the next trip'

  return (
    <Sheet open={open} onClose={close} title="Add an item" initialFocus={search} scrollKey={step?.kind ?? 'pick'}>
      {step?.kind === 'new' ? (
        <NewItemForm key={step.item.product?.id ?? 'typed'} draft={step.item} trip={trip} settings={settings} asOf={snapshot.as_of} money={shopMoney} onBack={() => setStep(null)} onSaved={close} />
      ) : step?.kind === 'linked' ? (
        <View style={{ gap: SPACE[4] }}>
          <Text>{`Already on your price list as ${step.item.name}.`}</Text>
          {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
          <Button label={edit.isPending ? 'Saving…' : 'Add to the list'} variant="primary" disabled={edit.isPending} onPress={() => void add(step.item.id)} />
          <Button label="Back to search" variant="plain" onPress={() => setStep(null)} />
        </View>
      ) : (
        <View style={{ gap: SPACE[4] }}>
          {trips.length > 1 ? <Choices label="Trip" layout="chips" groups={[{ choices: trips.map((d) => ({ value: d, title: dayName(d, locale, 'short') })) }]} value={trip} onChange={setTrip} /> : null}
          <TextField ref={search} label="Search" value={query} onChangeText={setQuery} hint="By name or aisle, such as rice or cleaning." autoCapitalize="none" autoCorrect={false} enterKeyHint="search" autoFocus={Platform.OS !== 'web'} />
          {matches.length > 0 ? (
            <>
              <Choices label="Item" groups={[{ choices: matches.map((i) => ({ value: i.id, title: i.name, detail: i.aisle ?? undefined })) }]} value={picked} onChange={setItem} />
              {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
              <Button label={edit.isPending ? 'Saving…' : 'Add to the list'} variant="primary" disabled={!picked || edit.isPending} onPress={() => picked && void add(picked)} />
            </>
          ) : (
            <Text tone="text2">{`None of your items match “${words}”.`}</Text>
          )}
          {words.length >= 2 ? (
            <View style={{ gap: SPACE[3] }}>
              <Text variant="subhead" tone="text2" style={STRONG}>
                Not on your price list?
              </Text>
              {searching ? (
                <Text tone="text2">Searching Mercadona…</Text>
              ) : !want ? (
                <Button label={`Search Mercadona for “${words}”`} variant="secondary" onPress={() => setAsked(true)} />
              ) : shop.error ? (
                <Banner tone="caution" title="Mercadona did not answer" body="Add the item by hand instead." detail={asDataError(shop.error).technical ?? undefined} />
              ) : (shop.data ?? []).length === 0 ? (
                <Text tone="text2">{`Mercadona has nothing for “${typed}”.`}</Text>
              ) : (
                <Choices
                  label="Mercadona products"
                  groups={[{ title: 'At Mercadona', choices: (shop.data ?? []).map((p) => ({ value: p.id, title: p.name, detail: `${productWords(p, shopMoney, locale)}${linkedItem(doc.items, p) ? ' · on your price list' : ''}` })) }]}
                  value={product}
                  onChange={setProduct}
                  onPress={choose}
                />
              )}
              <Button label={`Add “${words}” by hand`} variant="plain" onPress={byHand} />
            </View>
          ) : null}
          <Text variant="footnote" tone="text2">{`It stays on the list until it is ticked, from ${from}.`}</Text>
        </View>
      )}
    </Sheet>
  )
}

interface NewItemFormProps {
  draft: NewItem
  trip: string
  settings: MealSettings
  asOf: string
  money: (minor: number) => string
  onBack: () => void
  onSaved: () => void
}

// The new item before it is saved: its name, kind, price and aisle can change; its pack comes from the product.
function NewItemForm({ draft, trip, settings, asOf, money, onBack, onSaved }: NewItemFormProps) {
  const locale = useLocale()
  const edit = useMealEdit()
  // One id for every try, so a retry changes the row it made and adds none.
  const [id] = useState(() => randomId())
  const [name, setName] = useState(draft.name)
  const [kind, setKind] = useState<ItemKind>(draft.kind)
  const [price, setPrice] = useState(draft.price_minor === null ? '' : amountText(draft.price_minor, settings.currency, locale))
  const [aisle, setAisle] = useState(draft.aisle ?? '')
  const [tried, setTried] = useState(false)
  const failure = edit.error ? asDataError(edit.error) : null
  const priceMinor = price.trim() === '' ? null : parseAmount(price, locale, settings.currency)
  const errors = {
    name: name.trim() === '' ? 'Give the item a name.' : null,
    price: priceMinor !== null && priceMinor <= 0 ? 'A price above 0, or leave it empty.' : price.trim() !== '' && priceMinor === null ? 'Type the price as a number, such as 1.20.' : null,
  }
  const ok = Object.values(errors).every((e) => e === null)
  const shown = (e: string | null) => (tried ? e : null)
  const save = async () => {
    setTried(true)
    if (!ok) return
    const row: Item = {
      id,
      name: name.trim(),
      kind,
      unit: draft.unit,
      pack_size: draft.pack_size,
      loose: false,
      price_minor: priceMinor,
      price_checked_on: priceMinor === null ? null : asOf,
      // Mercadona's own price keeps its source; a changed one was typed.
      price_source: priceMinor === null ? null : draft.mercadona_id !== null && priceMinor === draft.price_minor ? 'mercadona' : 'typed',
      mercadona_id: draft.mercadona_id,
      aisle: aisle.trim() === '' ? null : aisle.trim().slice(0, 40),
      category_id: draft.category_id,
      lasts_days: null,
      wanted_on: trip,
      unavailable_on: null,
      at_home_on: null,
      archived_at: null,
    }
    try {
      await edit.mutateAsync({ kind: 'item', row })
      onSaved()
    } catch {
      // The banner says what went wrong.
    }
  }
  const p = draft.product
  return (
    <View style={{ gap: SPACE[4] }}>
      {p ? (
        <View style={{ gap: SPACE[1], alignItems: 'flex-start' }}>
          <Text variant="footnote" tone="text2">{`Mercadona: ${productWords(p, money, locale)}`}</Text>
          <Button label="Open on Mercadona" variant="plain" size="small" onPress={() => void Linking.openURL(mercadonaLink(p.id))} />
        </View>
      ) : (
        <Text variant="footnote" tone="text2">
          Saved with a pack of one. Change it in the price list.
        </Text>
      )}
      <TextField label="Name" value={name} onChangeText={setName} maxLength={60} error={shown(errors.name)} />
      <Segmented label="Kind" options={ITEM_KINDS.map((k) => ({ value: k, label: KIND_WORDS[k] }))} value={kind} onChange={setKind} />
      <TextField label="Price of one pack" value={price} onChangeText={setPrice} money={{ currency: settings.currency }} error={shown(errors.price)} />
      <TextField label="Aisle" value={aisle} onChangeText={setAisle} maxLength={40} />
      {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
      <Button label={edit.isPending ? 'Saving…' : 'Add to the list'} variant="primary" disabled={edit.isPending} onPress={() => void save()} />
      <Button label="Back to search" variant="plain" onPress={onBack} />
    </View>
  )
}
