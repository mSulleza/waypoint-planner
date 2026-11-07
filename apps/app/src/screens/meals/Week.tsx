import type { Snapshot } from '@waypoint/core'
import { missingMeals, type Cook, type DayPlan, type MealsDoc, type MealSettings, type Slot } from '@waypoint/core/meals'
import { starterDoc } from '@waypoint/core/meals-starter'
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
import { EmptyState } from '@/ui/EmptyState'
import { useMoneyText } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Row } from '@/ui/Row'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { useLocale } from '@/ui/theme'
import { SPACE } from '@/ui/tokens'
import { useAiEnabled, useMealEdit, useMeals } from './data'
import { categoryChoices, cookedWeekBefore, dayName, starterCategories, weekFromParam, weekView, WEEKDAYS } from './meals.model'
import { BudgetCard, Heading, LoadFailed, WeekStepper } from './parts'
import { PlanSheet } from './Plan'

// Meals: the week from the shopping day, one cook a day at lunch that also covers dinner unless a dinner is added, and its shopping against the meals allowance.
export function MealsBody() {
  const params = useLocalSearchParams<{ week?: string }>()
  const router = useRouter()
  const { doc, settings, snapshot, error, refetch } = useMeals()
  if (error) return <LoadFailed error={error} retry={refetch} />
  if (!doc || !settings || !snapshot) return <Text tone="text2">Loading…</Text>
  if (doc.recipes.length === 0) return <Start snapshot={snapshot} settings={settings} empty={doc.items.length === 0} />
  const start = weekFromParam(params.week, snapshot.as_of, settings.shop_weekday)
  return <Week doc={doc} settings={settings} snapshot={snapshot} start={start} onWeek={(week) => router.setParams({ week })} />
}

// The starter pack fills empty meals only, so a household that has items already writes its first recipe instead.
function Start({ snapshot, settings, empty }: { snapshot: Snapshot; settings: MealSettings; empty: boolean }) {
  const edit = useMealEdit()
  const router = useRouter()
  const failure = edit.error ? asDataError(edit.error) : null
  const add = () => edit.mutate({ kind: 'starter', doc: starterDoc(starterCategories(snapshot, settings.category_id), settings.currency, settings.shop_weekday, settings.people) })
  return (
    <View style={{ gap: SPACE[4] }}>
      {empty ? (
        <>
          <EmptyState
            title="Plan the week's cooking"
            body="Start with 12 quick Asian recipes, each cooked once for lunch and dinner. Prices start empty: type them in or run the Mercadona refresh."
            action={{ label: edit.isPending ? 'Adding…' : 'Add the starter recipes', onPress: add }}
          />
          <Button label="Write my own recipe" variant="secondary" onPress={() => router.push('/meals/recipe/new')} />
        </>
      ) : (
        <EmptyState title="Plan the week's cooking" body="Write a recipe from the items in your price list, then pick it for a day." action={{ label: 'Write a recipe', onPress: () => router.push('/meals/recipe/new') }} />
      )}
      {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
    </View>
  )
}

interface Picking {
  day: string
  slot: Slot
  cook: Cook | null
}

function Week({ doc, settings, snapshot, start, onWeek }: { doc: MealsDoc; settings: MealSettings; snapshot: Snapshot; start: string; onWeek: (start: string) => void }) {
  const router = useRouter()
  const v = useMemo(() => weekView(snapshot, doc, settings, start), [snapshot, doc, settings, start])
  const missing = useMemo(() => new Map(missingMeals(doc, start).map((m) => [m.meal.id, m.items.map((i) => i.name).join(', ')])), [doc, start])
  const [picking, setPicking] = useState<Picking | null>(null)
  const [planning, setPlanning] = useState(false)
  const ai = useAiEnabled()
  return (
    <View style={{ gap: SPACE[5] }}>
      <WeekStepper start={start} asOf={snapshot.as_of} onWeek={onWeek} />
      <BudgetCard v={v} snapshot={snapshot} currency={settings.currency} />
      {ai ? <Button label="Plan this week with DeepSeek" icon="route" variant="secondary" onPress={() => setPlanning(true)} /> : null}
      <View style={{ gap: SPACE[3] }}>
        {v.days.map((d) => (
          <DayCard key={d.day} d={d} currency={settings.currency} today={d.day === snapshot.as_of} missing={missing} onPick={setPicking} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
        <Button label="Recipes" variant="secondary" onPress={() => router.push('/meals/recipes')} />
        <Button label="Price list" variant="secondary" onPress={() => router.push('/meals/items')} />
      </View>
      <SettingsCard snapshot={snapshot} settings={settings} />
      <MealPicker picking={picking} doc={doc} settings={settings} days={v.days} onClose={() => setPicking(null)} />
      <PlanSheet open={planning} doc={doc} settings={settings} snapshot={snapshot} start={start} onClose={() => setPlanning(false)} />
    </View>
  )
}

// missing: meal id to the items its trip did not have.
function DayCard({ d, currency, today, missing, onPick }: { d: DayPlan; currency: string; today: boolean; missing: ReadonlyMap<string, string>; onPick: (p: Picking) => void }) {
  const locale = useLocale()
  const money = useMoneyText()
  // A cost with every price missing would read as free, so it says so instead.
  const cost = (cook: Cook) => (cook.cost.missing === cook.cost.ingredients.length ? 'no prices yet' : `${money(cook.cost.per_portion_minor, currency)} a portion${cook.cost.missing > 0 ? `, ${cook.cost.missing} without a price` : ''}`)
  const detail = (cook: Cook, extra?: string) => [missing.has(cook.meal.id) ? `Missing ${missing.get(cook.meal.id)}, tap to change` : null, `${cook.recipe.prep_minutes} min`, cost(cook), extra].filter(Boolean).join(' · ')
  const dinner = d.dinner
  return (
    <View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE[2], marginBottom: SPACE[2] }}>
        <Text variant="headline" level={3}>
          {dayName(d.day, locale)}
        </Text>
        {today ? <Pill tone="neutral">Today</Pill> : null}
        {d.trip ? (
          <Pill tone="neutral" icon="wallet">
            Shopping day
          </Pill>
        ) : null}
      </View>
      <Card flush>
        <Row
          title={d.lunch ? d.lunch.recipe.name : 'Nothing planned'}
          detail={d.lunch ? `Lunch · ${detail(d.lunch, d.lunch.meal.leftovers ? 'cooks for dinner too' : undefined)}` : 'Lunch · tap to pick a recipe'}
          onPress={() => onPick({ day: d.day, slot: 'lunch', cook: d.lunch })}
        />
        <Row
          divider
          title={dinner === 'leftovers' ? 'Lunch again' : dinner ? dinner.recipe.name : 'Nothing planned'}
          detail={dinner === 'leftovers' ? 'Dinner · from lunch, no cooking' : dinner ? `Dinner · ${detail(dinner)}` : 'Dinner · tap to cook a second time'}
          onPress={() => onPick({ day: d.day, slot: 'dinner', cook: dinner === 'leftovers' || dinner === null ? null : dinner })}
        />
      </Card>
    </View>
  )
}

// Picks the recipe for a lunch or a dinner; a lunch can cook for dinner too, which clears a dinner already planned.
function MealPicker({ picking, doc, settings, days, onClose }: { picking: Picking | null; doc: MealsDoc; settings: MealSettings; days: readonly DayPlan[]; onClose: () => void }) {
  const edit = useMealEdit()
  const locale = useLocale()
  const [recipe, setRecipe] = useState<string | null>(null)
  const [leftovers, setLeftovers] = useState(true)
  const [opened, setOpened] = useState<Picking | null>(null)
  // A new opening starts from the meal it opened on.
  if (picking !== opened) {
    setOpened(picking)
    setRecipe(picking?.cook?.recipe.id ?? null)
    setLeftovers(picking?.cook ? picking.cook.meal.leftovers : picking?.slot === 'lunch')
  }
  if (!picking) return <Sheet open={false} onClose={onClose} title="Meal">{null}</Sheet>
  const day = days.find((d) => d.day === picking.day)
  const dinner = day && day.dinner !== 'leftovers' ? day.dinner : null
  const lunch = day?.lunch ?? null
  const failure = edit.error ? asDataError(edit.error) : null
  const recipes = doc.recipes.filter((r) => r.archived_at === null).sort((a, b) => a.name.localeCompare(b.name, locale))
  const lastWeek = cookedWeekBefore(doc, picking.day, settings.shop_weekday)
  const save = async () => {
    if (!recipe) return
    const isLunch = picking.slot === 'lunch'
    const drop = isLunch && leftovers && dinner ? [dinner.meal.id] : []
    // Dinner from scratch ends lunch's leftovers, so the day cooks twice.
    const unleft = !isLunch && lunch?.meal.leftovers ? lunch : null
    try {
      if (drop.length > 0) await edit.mutateAsync({ kind: 'unmeal', ids: drop })
      if (unleft) await edit.mutateAsync({ kind: 'meal', row: { ...unleft.meal, leftovers: false } })
      await edit.mutateAsync({ kind: 'meal', row: { id: picking.cook?.meal.id ?? randomId(), day: picking.day, slot: picking.slot, recipe_id: recipe, leftovers: isLunch && leftovers } })
      onClose()
    } catch {
      // The banner below says what went wrong.
    }
  }
  const remove = async () => {
    if (!picking.cook) return
    try {
      await edit.mutateAsync({ kind: 'unmeal', ids: [picking.cook.meal.id] })
      onClose()
    } catch {
      // The banner below says what went wrong.
    }
  }
  const title = `${picking.slot === 'lunch' ? 'Lunch' : 'Dinner'}, ${dayName(picking.day, locale)}`
  return (
    <Sheet open onClose={onClose} title={title}>
      <View style={{ gap: SPACE[4] }}>
        <Choices label="Recipe" groups={[{ choices: recipes.map((r) => ({ value: r.id, title: r.name, detail: `${r.prep_minutes} min · serves ${r.portions}${lastWeek.has(r.id) ? ' · cooked last week' : ''}` })) }]} value={recipe} onChange={setRecipe} />
        {picking.slot === 'lunch' ? <Checkbox label="Cook enough for dinner too" detail={dinner ? 'Takes the place of the dinner planned for this day.' : `Cooks for ${settings.people * 2} portions.`} checked={leftovers} onChange={setLeftovers} /> : null}
        {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
          <Button label={edit.isPending ? 'Saving…' : 'Save'} variant="primary" disabled={!recipe || edit.isPending} onPress={() => void save()} />
          {picking.cook ? <Button label="Take off the plan" variant="secondary" disabled={edit.isPending} onPress={() => void remove()} /> : null}
        </View>
      </View>
    </Sheet>
  )
}

const PEOPLE = ['1', '2', '3', '4', '5', '6'] as const

const Label = ({ children }: { children: string }) => (
  <Text variant="subhead" tone="text2" style={{ fontWeight: '600', marginTop: SPACE[2] }}>
    {children}
  </Text>
)

// Where meals count, the shopping day and how many eat.
function SettingsCard({ snapshot, settings }: { snapshot: Snapshot; settings: MealSettings }) {
  const edit = useMealEdit()
  const failure = edit.error ? asDataError(edit.error) : null
  const set = (patch: Partial<MealSettings>) => edit.mutate({ kind: 'settings', row: { ...settings, ...patch } })
  return (
    <View>
      <Heading title="Settings" />
      <Card style={{ gap: SPACE[3] }}>
        <Label>Meals count against</Label>
        <Choices label="Meals count against" groups={[{ choices: categoryChoices(snapshot, settings.category_id) }]} value={settings.category_id} onChange={(category_id) => set({ category_id })} />
        <Label>Main shopping day, which starts each week</Label>
        <Choices label="Main shopping day, which starts each week" layout="chips" groups={[{ choices: WEEKDAYS.map((w, i) => ({ value: String(i), title: w.slice(0, 3), label: w })) }]} value={String(settings.shop_weekday)} onChange={(d) => set({ shop_weekday: Number(d) })} />
        <Label>People eating</Label>
        <Choices label="People eating" layout="chips" groups={[{ choices: PEOPLE.map((p) => ({ value: p, title: p })) }]} value={String(settings.people)} onChange={(p) => set({ people: Number(p) })} />
        {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
      </Card>
    </View>
  )
}
