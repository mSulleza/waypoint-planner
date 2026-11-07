import { cookCost, mealsIndex, type Item, type MealsDoc, type MealSettings, type Recipe, type RecipeItem } from '@waypoint/core/meals'
import { useRouter } from 'expo-router'
import { useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { randomId } from '@/data/uuid'
import { Missing } from '@/shell/Missing'
import { useBack } from '@/shell/useBack'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Choices } from '@/ui/Choices'
import { EmptyState } from '@/ui/EmptyState'
import { useMoneyText } from '@/ui/Money'
import { Row } from '@/ui/Row'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { TextField } from '@/ui/TextField'
import { useLocale } from '@/ui/theme'
import { SPACE } from '@/ui/tokens'
import { useMealEdit, useMeals } from './data'
import { amountWords } from './meals.model'
import { Heading, LoadFailed } from './parts'

export const NEW_RECIPE_ID = 'new'

// Every recipe with its time and what it costs for its portions.
export function RecipesBody() {
  const router = useRouter()
  const locale = useLocale()
  const money = useMoneyText()
  const { doc, settings, error, refetch } = useMeals()
  if (error) return <LoadFailed error={error} retry={refetch} />
  if (!doc || !settings) return <Text tone="text2">Loading…</Text>
  const recipes = [...doc.recipes].sort((a, b) => Number(a.archived_at !== null) - Number(b.archived_at !== null) || a.name.localeCompare(b.name, locale))
  return (
    <View style={{ gap: SPACE[4] }}>
      <Button label="New recipe" icon="plus" variant="primary" onPress={() => router.push(`/meals/recipe/${NEW_RECIPE_ID}`)} />
      {recipes.length === 0 ? (
        <EmptyState title="No recipes yet" body="Add the starter recipes from Meals, or write your own." action={{ label: 'Open Meals', onPress: () => router.push('/meals') }} />
      ) : (
        <Card flush>
          {recipes.map((r, i) => {
            const cost = cookCost(doc, r.id, r.portions)
            const words = [`${r.prep_minutes} min`, `serves ${r.portions}`, `${money(cost.cost_minor, settings.currency)}${cost.missing > 0 ? `, ${cost.missing} without a price` : ''}`, r.archived_at ? 'archived' : null]
            return <Row key={r.id} divider={i > 0} title={r.name} detail={words.filter(Boolean).join(' · ')} onPress={() => router.push(`/meals/recipe/${r.id}`)} />
          })}
        </Card>
      )}
    </View>
  )
}

interface LineDraft {
  id: string
  item_id: string
  quantity: string
}

// /meals/recipe/<id> edits a recipe, /meals/recipe/new writes one.
export function RecipeEditor({ id }: { id: string }) {
  const { doc, settings, error, refetch } = useMeals()
  if (error) return <LoadFailed error={error} retry={refetch} />
  if (!doc || !settings) return <Text tone="text2">Loading…</Text>
  const recipe = doc.recipes.find((r) => r.id === id) ?? null
  if (!recipe && id !== NEW_RECIPE_ID) return <Missing what="recipe" list="/meals/recipes" listTitle="Recipes" />
  return <RecipeForm doc={doc} settings={settings} loaded={recipe} />
}

const whole = (text: string, min: number, max: number) => {
  const n = Number(text.trim())
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}
const amount = (text: string) => {
  const n = Number(text.trim().replace(',', '.'))
  return Number.isFinite(n) && n > 0 && n < 10_000_000 ? Math.round(n * 1000) / 1000 : null
}

function RecipeForm({ doc, settings, loaded }: { doc: MealsDoc; settings: MealSettings; loaded: Recipe | null }) {
  const locale = useLocale()
  const leave = useBack()
  const money = useMoneyText()
  const edit = useMealEdit()
  const index = mealsIndex(doc)
  const [id] = useState(() => loaded?.id ?? randomId())
  const before = useRef<readonly RecipeItem[]>(loaded ? (index.lines.get(loaded.id) ?? []) : [])
  const [name, setName] = useState(loaded?.name ?? '')
  const [portions, setPortions] = useState(String(loaded?.portions ?? settings.people * 2))
  const [prep, setPrep] = useState(String(loaded?.prep_minutes ?? 20))
  const [steps, setSteps] = useState(loaded?.steps ?? '')
  const [lines, setLines] = useState<LineDraft[]>(() => before.current.map((l) => ({ id: l.id, item_id: l.item_id, quantity: String(l.quantity) })))
  const [picking, setPicking] = useState(false)
  const [tried, setTried] = useState(false)
  const failure = edit.error ? asDataError(edit.error) : null
  const errors = {
    name: name.trim() === '' ? 'Give the recipe a name.' : name.trim().length > 60 ? 'Keep the name to 60 characters.' : null,
    portions: whole(portions, 1, 24) === null ? 'A whole number from 1 to 24.' : null,
    prep: whole(prep, 1, 600) === null ? 'Minutes, a whole number from 1 to 600.' : null,
    lines: lines.some((l) => amount(l.quantity) === null) ? 'Every ingredient needs an amount above 0.' : null,
  }
  const ok = Object.values(errors).every((e) => e === null)
  const shown = (e: string | null) => (tried ? e : null)
  const cost = useMemo(() => {
    const p = whole(portions, 1, 24)
    return p === null ? null : cookCost(doc, loaded?.id ?? '', p)
  }, [doc, loaded, portions])
  const save = async (archived_at: string | null = loaded?.archived_at ?? null) => {
    setTried(true)
    if (!ok) return
    const row: Recipe = { id, name: name.trim(), portions: whole(portions, 1, 24)!, prep_minutes: whole(prep, 1, 600)!, steps: steps.trim(), archived_at }
    const kept = lines.map((l, i): RecipeItem => ({ id: l.id, recipe_id: id, item_id: l.item_id, quantity: amount(l.quantity)!, sort_order: i }))
    const removed = before.current.filter((b) => !kept.some((k) => k.id === b.id)).map((b) => b.id)
    try {
      await edit.mutateAsync({ kind: 'recipe', row, lines: kept, removed })
      leave()
    } catch {
      // The banner says what went wrong.
    }
  }
  const item = (itemId: string): Item | undefined => index.items.get(itemId)
  const used = new Set(lines.map((l) => l.item_id))
  return (
    <View style={{ gap: SPACE[5] }}>
      <TextField label="Name" value={name} onChangeText={setName} error={shown(errors.name)} maxLength={60} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[4], rowGap: SPACE[5] }}>
        <View style={{ flexGrow: 1, flexBasis: 140 }}>
          <TextField label="Portions" value={portions} onChangeText={setPortions} numbers inputMode="numeric" error={shown(errors.portions)} hint="Lunch and dinner for two is 4." />
        </View>
        <View style={{ flexGrow: 1, flexBasis: 140 }}>
          <TextField label="Prep and cooking" value={prep} onChangeText={setPrep} numbers inputMode="numeric" suffix="min" error={shown(errors.prep)} />
        </View>
      </View>
      <View>
        <Heading title="Ingredients">
          {cost && loaded ? <Text variant="footnote" tone="text2">{`${money(cost.cost_minor, settings.currency)} as saved${cost.missing > 0 ? `, ${cost.missing} without a price` : ''}`}</Text> : null}
        </Heading>
        <Card style={{ gap: SPACE[4] }}>
          {lines.length === 0 ? <Text tone="text2">No ingredients yet.</Text> : null}
          {lines.map((l, i) => {
            const it = item(l.item_id)
            return (
              <View key={l.id} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: SPACE[2] }}>
                <View style={{ flex: 1 }}>
                  <TextField
                    label={it ? `${it.name}${it.kind === 'stock' ? ' (kept in)' : ''}` : 'Item'}
                    value={l.quantity}
                    onChangeText={(quantity) => setLines((all) => all.map((x, j) => (j === i ? { ...x, quantity } : x)))}
                    numbers
                    inputMode="decimal"
                    suffix={it ? (it.unit === 'unit' ? '×' : it.unit) : undefined}
                    hint={it ? `A pack is ${amountWords(it.pack_size, it.unit, locale)}` : undefined}
                  />
                </View>
                <Button label={`Take out ${it?.name ?? 'this item'}`} icon="x" variant="icon" iconOnly onPress={() => setLines((all) => all.filter((_, j) => j !== i))} />
              </View>
            )
          })}
          {shown(errors.lines) ? <Text variant="footnote" tone="text2">{errors.lines}</Text> : null}
          <Button label="Add an ingredient" icon="plus" variant="secondary" onPress={() => setPicking(true)} />
        </Card>
      </View>
      <TextField label="Steps" value={steps} onChangeText={setSteps} multiline numberOfLines={8} maxLength={4000} hint="One step a line; they print with the day's menu." />
      {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
        <Button label={edit.isPending ? 'Saving…' : 'Save'} variant="primary" disabled={edit.isPending} onPress={() => void save()} />
        {loaded ? <Button label={loaded.archived_at ? 'Bring back' : 'Archive'} variant="secondary" disabled={edit.isPending} onPress={() => void save(loaded.archived_at ? null : new Date().toISOString())} /> : null}
      </View>
      <Sheet open={picking} onClose={() => setPicking(false)} title="Add an ingredient">
        <Choices
          label="Item"
          groups={[{ choices: doc.items.filter((it) => it.archived_at === null && !used.has(it.id)).sort((a, b) => a.name.localeCompare(b.name, locale)).map((it) => ({ value: it.id, title: it.name, detail: `${it.kind === 'stock' ? 'Kept in' : 'Bought for recipes'} · a pack is ${amountWords(it.pack_size, it.unit, locale)}` })) }]}
          value={null}
          onChange={(item_id) => {
            const it = item(item_id)
            setLines((all) => [...all, { id: randomId(), item_id, quantity: it ? String(it.unit === 'unit' ? 1 : it.pack_size) : '1' }])
            setPicking(false)
          }}
        />
      </Sheet>
    </View>
  )
}
