import { addDays, parseAmount, type Snapshot } from '@waypoint/core'
import { forecast, ITEM_KINDS, UNITS, type Item, type ItemKind, type MealsDoc, type MealSettings, type Unit } from '@waypoint/core/meals'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Linking, View } from 'react-native'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { amountText } from '@/data/field-text'
import { randomId } from '@/data/uuid'
import { Missing } from '@/shell/Missing'
import { useBack } from '@/shell/useBack'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Checkbox } from '@/ui/Checkbox'
import { Choices } from '@/ui/Choices'
import { useMoneyText } from '@/ui/Money'
import { Row } from '@/ui/Row'
import { Segmented } from '@/ui/Segmented'
import { Text } from '@/ui/Text'
import { TextField } from '@/ui/TextField'
import { useLocale } from '@/ui/theme'
import { SPACE } from '@/ui/tokens'
import { useMealEdit, useMeals } from './data'
import { amountWords, categoryChoices, dayName, mercadonaIdFrom, mercadonaLink, priceList } from './meals.model'
import { Heading, LoadFailed } from './parts'

export const NEW_ITEM_ID = 'new'

// The price list: every item by aisle, its price with the day it was checked and where from, and when a kept-in item runs out.
export function ItemsBody() {
  const router = useRouter()
  const locale = useLocale()
  const money = useMoneyText()
  const { doc, settings, snapshot, error, refetch } = useMeals()
  if (error) return <LoadFailed error={error} retry={refetch} />
  if (!doc || !settings || !snapshot) return <Text tone="text2">Loading…</Text>
  const groups = priceList(doc, snapshot.as_of, (m) => money(m, settings.currency), locale)
  const linked = doc.items.filter((i) => i.mercadona_id !== null && i.archived_at === null).length
  return (
    <View style={{ gap: SPACE[5] }}>
      <Button label="New item" icon="plus" variant="primary" onPress={() => router.push(`/meals/item/${NEW_ITEM_ID}`)} />
      <Text variant="footnote" tone="text2">
        {`Prices are saved, never fetched on view. Type them in, or link an item to Mercadona and run the refresh command (${linked} linked).`}
      </Text>
      {groups.map((g) => (
        <View key={g.aisle}>
          <Heading title={g.aisle} />
          <Card flush>
            {g.rows.map((r, i) => {
              const runs = r.runs_out ? `runs out about ${dayName(r.runs_out, locale, 'short')}` : r.item.kind === 'stock' ? 'tick it on a trip to start the forecast' : null
              return (
                <Row
                  key={r.item.id}
                  divider={i > 0}
                  title={r.item.name}
                  detail={[`${amountWords(r.item.pack_size, r.item.unit, locale)}${r.item.loose ? ', loose' : ''}`, r.price.stale ? `${r.price.text}, check again` : r.price.text, runs].filter(Boolean).join(' · ')}
                  onPress={() => router.push(`/meals/item/${r.item.id}`)}
                />
              )
            })}
          </Card>
        </View>
      ))}
    </View>
  )
}

// /meals/item/<id> edits an item, /meals/item/new adds one.
export function ItemEditor({ id }: { id: string }) {
  const { doc, settings, snapshot, error, refetch } = useMeals()
  if (error) return <LoadFailed error={error} retry={refetch} />
  if (!doc || !settings || !snapshot) return <Text tone="text2">Loading…</Text>
  const item = doc.items.find((i) => i.id === id) ?? null
  if (!item && id !== NEW_ITEM_ID) return <Missing what="item" list="/meals/items" listTitle="Price list" />
  return <ItemForm doc={doc} settings={settings} snapshot={snapshot} loaded={item} />
}

export const KIND_WORDS: Record<ItemKind, string> = { recipe: 'For recipes', stock: 'Kept in' }
const UNIT_WORDS: Record<Unit, string> = { g: 'Grams', ml: 'Millilitres', unit: 'Count' }

function ItemForm({ doc, settings, snapshot, loaded }: { doc: MealsDoc; settings: MealSettings; snapshot: Snapshot; loaded: Item | null }) {
  const locale = useLocale()
  const leave = useBack()
  const edit = useMealEdit()
  const asOf = snapshot.as_of
  const [id] = useState(() => loaded?.id ?? randomId())
  const [name, setName] = useState(loaded?.name ?? '')
  const [kind, setKind] = useState<ItemKind>(loaded?.kind ?? 'recipe')
  const [unit, setUnit] = useState<Unit>(loaded?.unit ?? 'g')
  const [pack, setPack] = useState(loaded ? String(loaded.pack_size) : '')
  const [loose, setLoose] = useState(loaded?.loose ?? false)
  const [price, setPrice] = useState(loaded && loaded.price_minor !== null ? amountText(loaded.price_minor, settings.currency, locale) : '')
  const [link, setLink] = useState(loaded?.mercadona_id ?? '')
  const [aisle, setAisle] = useState(loaded?.aisle ?? '')
  const [category, setCategory] = useState<string | null>(loaded?.category_id ?? null)
  const [lasts, setLasts] = useState(loaded && loaded.lasts_days !== null ? String(loaded.lasts_days) : '')
  const [tried, setTried] = useState(false)
  const failure = edit.error ? asDataError(edit.error) : null
  const packSize = Number(pack.trim().replace(',', '.'))
  const priceMinor = price.trim() === '' ? null : parseAmount(price, locale, settings.currency)
  const mercadona = link.trim() === '' ? null : mercadonaIdFrom(link)
  const lastsDays = lasts.trim() === '' ? null : Number(lasts.trim())
  const errors = {
    name: name.trim() === '' ? 'Give the item a name.' : null,
    pack: !(Number.isFinite(packSize) && packSize > 0 && packSize < 10_000_000) ? 'How much one pack holds, above 0.' : null,
    price: priceMinor !== null && priceMinor <= 0 ? 'A price above 0, or leave it empty.' : price.trim() !== '' && priceMinor === null ? 'Type the price as a number, such as 1.20.' : null,
    link: link.trim() !== '' && mercadona === null ? 'Paste a tienda.mercadona.es/product/… link or its number.' : null,
    lasts: lastsDays !== null && !(Number.isInteger(lastsDays) && lastsDays >= 1 && lastsDays <= 730) ? 'Whole days, from 1 to 730.' : null,
  }
  const ok = Object.values(errors).every((e) => e === null)
  const shown = (e: string | null) => (tried ? e : null)
  const f = loaded && loaded.kind === 'stock' ? forecast(doc, loaded, addDays(asOf, 1)) : null
  const row = (archived_at: string | null): Item => {
    const priceChanged = priceMinor !== (loaded?.price_minor ?? null)
    return {
      id,
      name: name.trim(),
      kind,
      unit,
      pack_size: Math.round(packSize * 1000) / 1000,
      loose,
      price_minor: priceMinor,
      // A new or changed price is checked today, typed in; an unchanged one keeps its day and source.
      price_checked_on: priceMinor === null ? null : priceChanged ? asOf : (loaded?.price_checked_on ?? asOf),
      price_source: priceMinor === null ? null : priceChanged ? 'typed' : (loaded?.price_source ?? 'typed'),
      mercadona_id: mercadona,
      aisle: aisle.trim() === '' ? null : aisle.trim().slice(0, 40),
      category_id: category,
      lasts_days: kind === 'stock' ? lastsDays : null,
      wanted_on: loaded?.wanted_on ?? null,
      unavailable_on: loaded?.unavailable_on ?? null,
      at_home_on: loaded?.at_home_on ?? null,
      archived_at,
    }
  }
  const save = async (archived_at: string | null = loaded?.archived_at ?? null) => {
    setTried(true)
    if (!ok) return
    try {
      await edit.mutateAsync({ kind: 'item', row: row(archived_at) })
      leave()
    } catch {
      // The banner says what went wrong.
    }
  }
  const bought = () => loaded && edit.mutate({ kind: 'buy', row: { id: randomId(), item_id: loaded.id, bought_on: asOf, packs: 1, price_minor: null } })
  const want = () => loaded && edit.mutate({ kind: 'item_patch', id: loaded.id, patch: { wanted_on: loaded.wanted_on ? null : asOf } })
  const choices = [{ value: '', title: 'The meals allowance' }, ...categoryChoices(snapshot, settings.category_id).filter((c) => c.value !== settings.category_id)]
  return (
    <View style={{ gap: SPACE[5] }}>
      <TextField label="Name" value={name} onChangeText={setName} maxLength={60} error={shown(errors.name)} />
      <Segmented label="Kind" options={ITEM_KINDS.map((k) => ({ value: k, label: KIND_WORDS[k] }))} value={kind} onChange={setKind} />
      <Text variant="footnote" tone="text2">
        {kind === 'recipe' ? 'Bought for the week’s meals, as much as their recipes need, rounded up to whole packs.' : 'Kept in, like rice, soap or shampoo, and put on the list before it runs out.'}
      </Text>
      <Segmented label="Measured in" options={UNITS.map((u) => ({ value: u, label: UNIT_WORDS[u] }))} value={unit} onChange={setUnit} />
      <TextField label="One pack holds" value={pack} onChangeText={setPack} numbers inputMode="decimal" suffix={unit === 'unit' ? '×' : unit} error={shown(errors.pack)} />
      <Checkbox label="Sold loose, by weight" detail="Bought by the amount needed, priced by the pack size above." checked={loose} onChange={setLoose} />
      <TextField label="Price of one pack" value={price} onChangeText={setPrice} money={{ currency: settings.currency }} error={shown(errors.price)} note={loaded?.price_checked_on ? `Checked ${dayName(loaded.price_checked_on, locale, 'short')}${loaded.price_source === 'mercadona' ? ', Mercadona online' : loaded.price_source === 'paid' ? ', price paid' : ''}` : null} />
      <TextField label="Mercadona product" value={link} onChangeText={setLink} autoCapitalize="none" autoCorrect={false} hint="Paste the product's link from tienda.mercadona.es. The refresh command reads its price from there." error={shown(errors.link)} />
      {mercadona ? <Button label="Open on Mercadona" variant="plain" size="small" onPress={() => void Linking.openURL(mercadonaLink(mercadona))} /> : null}
      <TextField label="Aisle" value={aisle} onChangeText={setAisle} maxLength={40} hint="The list groups items by it, in your shop's order." />
      <View style={{ gap: SPACE[2] }}>
        <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
          Counts against
        </Text>
        <Choices label="Counts against" groups={[{ choices }]} value={category ?? ''} onChange={(v) => setCategory(v === '' ? null : v)} />
      </View>
      {kind === 'stock' ? (
        <TextField
          label="One pack lasts about"
          value={lasts}
          onChangeText={setLasts}
          numbers
          inputMode="numeric"
          suffix="days"
          error={shown(errors.lasts)}
          note={f?.learned ? `Learned from your purchases: ${f.lasts_days} days a pack.` : 'Your guess until it has been bought twice.'}
        />
      ) : null}
      {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
        <Button label={edit.isPending ? 'Saving…' : 'Save'} variant="primary" disabled={edit.isPending} onPress={() => void save()} />
        {loaded ? <Button label="Bought today" variant="secondary" disabled={edit.isPending} onPress={bought} /> : null}
        {loaded ? <Button label={loaded.wanted_on ? 'Take off the list' : 'Put on the next trip'} variant="secondary" disabled={edit.isPending} onPress={want} /> : null}
        {loaded ? <Button label={loaded.archived_at ? 'Bring back' : 'Archive'} variant="plain" disabled={edit.isPending} onPress={() => void save(loaded.archived_at ? null : new Date().toISOString())} /> : null}
      </View>
      {f?.last ? <Text variant="footnote" tone="text2">{`Last bought ${dayName(f.last.bought_on, locale, 'short')}${f.runs_out ? `; runs out about ${dayName(f.runs_out, locale, 'short')}` : ''}.`}</Text> : null}
    </View>
  )
}
