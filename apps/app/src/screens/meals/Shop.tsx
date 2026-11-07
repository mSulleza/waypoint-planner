import type { Snapshot } from '@waypoint/core'
import { missingMeals, weekDays, weekTrips, type Item, type MealsDoc, type MealSettings, type MissingMeal, type ShopLine, type TripList } from '@waypoint/core/meals'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { randomId } from '@/data/uuid'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Checkbox } from '@/ui/Checkbox'
import { Choices } from '@/ui/Choices'
import { Money, useMoneyText } from '@/ui/Money'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { useLocale } from '@/ui/theme'
import { GUTTER, SPACE } from '@/ui/tokens'
import { AddItem } from './AddItem'
import { useAiEnabled, useMealEdit, useMeals } from './data'
import { buyWords, byAisle, dayName, priceWords, reasonWords, weekFromParam, weekView } from './meals.model'
import { BudgetCard, Heading, LoadFailed, STRONG, WeekStepper } from './parts'
import { SwapSheet, type Asking } from './Swap'

// The shopping list: one list per trip, by aisle, each line ticked off as it goes in the trolley.
export function ShopBody() {
  const params = useLocalSearchParams<{ week?: string }>()
  const router = useRouter()
  const { doc, settings, snapshot, error, refetch } = useMeals()
  if (error) return <LoadFailed error={error} retry={refetch} />
  if (!doc || !settings || !snapshot) return <Text tone="text2">Loading…</Text>
  const start = weekFromParam(params.week, snapshot.as_of, settings.shop_weekday)
  return <Shop doc={doc} settings={settings} snapshot={snapshot} start={start} onWeek={(week) => router.setParams({ week })} />
}

function Shop({ doc, settings, snapshot, start, onWeek }: { doc: MealsDoc; settings: MealSettings; snapshot: Snapshot; start: string; onWeek: (start: string) => void }) {
  const router = useRouter()
  const edit = useMealEdit()
  const v = useMemo(() => weekView(snapshot, doc, settings, start), [snapshot, doc, settings, start])
  const [adding, setAdding] = useState<'trip' | 'item' | null>(null)
  const [asking, setAsking] = useState<Asking | null>(null)
  const ai = useAiEnabled()
  const missing = useMemo(() => missingMeals(doc, start), [doc, start])
  const failure = edit.error ? asDataError(edit.error) : null
  const saved = new Set(doc.trips.map((t) => t.day))
  const trips = weekTrips(doc, start)
  const removeTrip = (day: string) => {
    // The first trip stays as the week's default once the others are gone; saving the rest keeps them apart from it.
    edit.mutate({ kind: 'untrip', day })
  }
  return (
    <View style={{ gap: SPACE[5] }}>
      <WeekStepper start={start} asOf={snapshot.as_of} onWeek={onWeek} />
      <BudgetCard v={v} snapshot={snapshot} currency={settings.currency} links={false} />
      {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
      {v.trips.map((t) => (
        <TripCard
          key={t.day}
          t={t}
          settings={settings}
          asOf={snapshot.as_of}
          removable={saved.has(t.day) && trips.length > 1}
          onRemove={() => removeTrip(t.day)}
          missing={missing.filter((m) => m.trip === t.day)}
          ai={ai}
          onAsk={(item) => setAsking({ item, trip: t.day })}
          onChangeMeal={() => router.push(`/meals?week=${start}`)}
        />
      ))}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
        <Button label="Add a trip" icon="plus" variant="secondary" onPress={() => setAdding('trip')} />
        <Button label="Add an item" icon="plus" variant="secondary" onPress={() => setAdding('item')} />
        <Button label="Print the list" variant="secondary" onPress={() => router.push(`/meals/print?week=${start}`)} />
      </View>
      <Text variant="footnote" tone="text2">
        Recipe items go on the last trip before their meal. Kept-in items go on the last trip before they run out, learned from your ticks.
      </Text>
      <SwapSheet asking={asking} doc={doc} settings={settings} onClose={() => setAsking(null)} />
      <AddTrip open={adding === 'trip'} start={start} trips={trips} onClose={() => setAdding(null)} />
      <AddItem open={adding === 'item'} doc={doc} settings={settings} snapshot={snapshot} trips={trips} onClose={() => setAdding(null)} />
    </View>
  )
}

interface TripCardProps {
  t: TripList
  settings: MealSettings
  asOf: string
  removable: boolean
  onRemove: () => void
  // Meals this trip buys for that need a swap, and how to fix them: DeepSeek where the account has it, else Meals.
  missing: readonly MissingMeal[]
  ai: boolean
  onAsk: (item: Item) => void
  onChangeMeal: () => void
}

function TripCard({ t, settings, asOf, removable, onRemove, missing, ai, onAsk, onChangeMeal }: TripCardProps) {
  const locale = useLocale()
  const money = useMoneyText()
  const edit = useMealEdit()
  const tick = (l: ShopLine, on: boolean) => {
    if (on) edit.mutate({ kind: 'buy', row: { id: randomId(), item_id: l.item.id, bought_on: t.day, packs: l.packs, price_minor: null } })
    else if (l.bought) edit.mutate({ kind: 'unbuy', id: l.bought.id })
  }
  const stock = (l: ShopLine, out: boolean) => edit.mutate({ kind: 'item_patch', id: l.item.id, patch: { unavailable_on: out ? t.day : null } })
  const home = (l: ShopLine, have: boolean) => edit.mutate({ kind: 'item_patch', id: l.item.id, patch: { at_home_on: have ? t.day : null } })
  const byItem = new Map<string, { item: Item; meals: MissingMeal[] }>()
  for (const m of missing) for (const item of m.items) byItem.set(item.id, { item, meals: [...(byItem.get(item.id)?.meals ?? []), m] })
  return (
    <View>
      <Heading title={dayName(t.day, locale)}>
        <Text variant="footnote" tone="text2" numbers>
          <Money minor={t.cost_minor} currency={settings.currency} variant="footnote" style={STRONG} />
          {` · ${t.bought} of ${t.lines.length - t.unavailable - t.at_home} bought${t.unavailable > 0 ? ` · ${t.unavailable} not in stock` : ''}${t.at_home > 0 ? ` · ${t.at_home} at home` : ''}`}
        </Text>
      </Heading>
      {[...byItem.values()].map(({ item, meals }) => (
        <View key={item.id} style={{ marginBottom: SPACE[3] }}>
          <Banner
            tone="caution"
            title={`${item.name}: not in stock`}
            body={`${meals.map((m) => `${dayName(m.meal.day, locale, 'short')}: ${m.recipe.name}`).join('; ')} ${meals.length === 1 ? 'needs' : 'need'} a change.`}
            action={ai ? { label: 'Ask DeepSeek', onPress: () => onAsk(item) } : { label: 'Change the meal', onPress: onChangeMeal }}
          />
        </View>
      ))}
      {t.lines.length === 0 ? (
        <Card>
          <Text tone="text2">Nothing to buy on this trip yet.</Text>
        </Card>
      ) : (
        <Card flush>
          {byAisle(t.lines).map((group) => (
            <View key={group.aisle} style={{ paddingTop: SPACE[3] }}>
              <Text variant="footnote" tone="text2" style={[STRONG, { paddingHorizontal: GUTTER }]}>
                {group.aisle}
              </Text>
              {group.lines.map((l) => {
                const price = priceWords(l.item, asOf, (m) => money(m, settings.currency), locale)
                const cost = l.cost_minor === null ? 'No price' : money(l.cost_minor, settings.currency)
                if (l.at_home) {
                  return (
                    <View key={l.item.id} style={{ paddingHorizontal: GUTTER, paddingVertical: SPACE[2], gap: SPACE[1] }}>
                      <Text tone="text3" style={{ textDecorationLine: 'line-through' }}>
                        {buyWords(l, locale)}
                      </Text>
                      <Text variant="footnote" tone="text2">
                        We have it at home, so it is off this trip
                      </Text>
                      <View style={{ flexDirection: 'row' }}>
                        <Button label="Put it back on the list" accessibilityLabel={`${l.item.name}: put it back on the list`} variant="plain" size="small" onPress={() => home(l, false)} />
                      </View>
                    </View>
                  )
                }
                if (l.unavailable) {
                  // A kept-in item no meal needs gets DeepSeek's "buy instead"; a recipe item is fixed from the banner above.
                  const forMeals = byItem.has(l.item.id)
                  return (
                    <View key={l.item.id} style={{ paddingHorizontal: GUTTER, paddingVertical: SPACE[2], gap: SPACE[1] }}>
                      <Text tone="text3" style={{ textDecorationLine: 'line-through' }}>
                        {buyWords(l, locale)}
                      </Text>
                      <Text variant="footnote" tone="text2">
                        Not in stock on this trip{l.item.kind === 'stock' ? '; it goes on the next trip' : ''}
                      </Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
                        <Button label="Back in stock" variant="plain" size="small" onPress={() => stock(l, false)} />
                        {ai && !forMeals ? <Button label="Ask DeepSeek" variant="secondary" size="small" onPress={() => onAsk(l.item)} /> : null}
                      </View>
                    </View>
                  )
                }
                return (
                  <View key={l.item.id} style={{ paddingHorizontal: GUTTER - SPACE[3], flexDirection: 'row', alignItems: 'flex-start' }}>
                    <View style={{ flex: 1 }}>
                      <Checkbox
                        label={buyWords(l, locale)}
                        detail={[cost, ...l.reasons.map((r) => reasonWords(r, locale)), l.cost_minor === null ? null : `${l.packs > 1 || l.item.loose ? price.text : price.checked}${price.stale ? ', check again' : ''}`].filter(Boolean).join(' · ')}
                        checked={l.bought !== null}
                        onChange={(on) => tick(l, on)}
                      />
                    </View>
                    {l.bought ? null : (
                      <View style={{ alignItems: 'flex-end' }}>
                        <Button label="We have it" accessibilityLabel={`${l.item.name}: we have it at home`} variant="plain" size="small" onPress={() => home(l, true)} />
                        <Button label="Not in stock" accessibilityLabel={`${l.item.name}: not in stock`} variant="plain" size="small" onPress={() => stock(l, true)} />
                      </View>
                    )}
                  </View>
                )
              })}
            </View>
          ))}
        </Card>
      )}
      {removable ? (
        <View style={{ marginTop: SPACE[2], alignItems: 'flex-start' }}>
          <Button label="Remove this trip" variant="plain" size="small" onPress={onRemove} />
        </View>
      ) : null}
    </View>
  )
}

function AddTrip({ open, start, trips, onClose }: { open: boolean; start: string; trips: readonly string[]; onClose: () => void }) {
  const locale = useLocale()
  const edit = useMealEdit()
  const [day, setDay] = useState<string | null>(null)
  const days = weekDays(start).filter((d) => !trips.includes(d))
  const save = async () => {
    if (!day) return
    try {
      // The week's first trip is only a default until a trip is saved, so it is saved too.
      for (const d of trips) await edit.mutateAsync({ kind: 'trip', id: randomId(), day: d })
      await edit.mutateAsync({ kind: 'trip', id: randomId(), day })
      setDay(null)
      onClose()
    } catch {
      // The page's banner says what went wrong.
    }
  }
  return (
    <Sheet open={open} onClose={onClose} title="Add a trip">
      <View style={{ gap: SPACE[4] }}>
        <Text tone="text2">Meals from this day on take their recipe items from the new trip, so fresh food is bought nearer the day.</Text>
        <Choices label="Day" groups={[{ choices: days.map((d) => ({ value: d, title: dayName(d, locale) })) }]} value={day} onChange={setDay} />
        <Button label={edit.isPending ? 'Saving…' : 'Add the trip'} variant="primary" disabled={!day || edit.isPending} onPress={() => void save()} />
      </View>
    </Sheet>
  )
}
