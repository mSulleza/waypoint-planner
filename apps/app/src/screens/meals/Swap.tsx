import type { SwapAnswer } from '@/ai/meals-swap'
import { mealsIndex, type Item, type MealsDoc, type MealSettings } from '@waypoint/core/meals'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { randomId } from '@/data/uuid'
import { Banner } from '@/ui/Banner'
import { Card } from '@/ui/Card'
import { useMoneyText } from '@/ui/Money'
import { Row } from '@/ui/Row'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { useLocale } from '@/ui/theme'
import { SPACE } from '@/ui/tokens'
import { askSwap, useMealEdit } from './data'
import { dayName } from './meals.model'
import { priceFix, variantRecipe } from './swap.model'

export interface Asking {
  item: Item
  trip: string
}

// DeepSeek's fixes for an item the trip did not have: per meal, another item in the same recipe or another recipe, each priced by the app; or what to buy instead.
export function SwapSheet({ asking, doc, settings, onClose }: { asking: Asking | null; doc: MealsDoc; settings: MealSettings; onClose: () => void }) {
  const locale = useLocale()
  const money = useMoneyText()
  const edit = useMealEdit()
  const [answer, setAnswer] = useState<SwapAnswer | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [round, setRound] = useState(0)
  const [done, setDone] = useState<ReadonlySet<string>>(new Set())
  const key = asking ? `${asking.item.id}:${asking.trip}` : null
  useEffect(() => {
    if (!asking) return
    let live = true
    setAnswer(null)
    setError(null)
    askSwap(asking.item.id, asking.trip).then(
      (a) => live && setAnswer(a),
      (e: unknown) => live && setError(e),
    )
    return () => {
      live = false
    }
    // A new item or a retry asks again; the same one keeps its answer.
  }, [key, round])
  useEffect(() => setDone(new Set()), [key])
  if (!asking) return <Sheet open={false} onClose={onClose} title="Swap">{null}</Sheet>
  const index = mealsIndex(doc)
  const failure = error ? asDataError(error) : edit.error ? asDataError(edit.error) : null
  const signed = (m: number) => `${m >= 0 ? '+' : '−'}${money(Math.abs(m), settings.currency)}`
  // Marks each key done once the writes have gone through; a refusal shows in the banner instead.
  const apply = async (keys: readonly string[], run: () => Promise<unknown>) => {
    try {
      await run()
      setDone((d) => new Set([...d, ...keys]))
    } catch {
      // The banner says what went wrong.
    }
  }
  const nothing = answer && answer.meals.length === 0 && answer.buy.length === 0
  return (
    <Sheet open onClose={onClose} title={`${asking.item.name} not in stock`}>
      <View style={{ gap: SPACE[4] }}>
        {!answer && !failure ? <Text tone="text2">Asking DeepSeek…</Text> : null}
        {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} action={error ? { label: 'Try again', onPress: () => setRound((r) => r + 1) } : undefined} /> : null}
        {nothing ? <Text tone="text2">DeepSeek had no fix that uses what the shop has. Pick another dish for that day in Meals.</Text> : null}
        {answer?.meals.map((m) => {
          const meal = doc.meals.find((x) => x.id === m.meal_id)
          const recipe = meal ? index.recipes.get(meal.recipe_id) : undefined
          if (!meal || !recipe) return null
          return (
            <View key={m.meal_id} style={{ gap: SPACE[2] }}>
              <Text variant="headline">{`${dayName(meal.day, locale)}, ${meal.slot}: ${recipe.name}`}</Text>
              <Card flush>
                {m.options.map((fix, i) => {
                  const priced = priceFix(doc, settings, meal, recipe, asking.item, fix)
                  if (!priced) return null
                  const id = `${m.meal_id}:${i}`
                  const cost = priced.missing > 0 ? `${priced.missing} without a price` : `${money(priced.cost_minor, settings.currency)} for the meal`
                  const detail = [done.has(id) ? 'Done' : null, fix.note || null, cost, priced.delta_minor !== null ? `${signed(priced.delta_minor)} against the plan` : null].filter(Boolean).join(' · ')
                  const use = () =>
                    apply([id, m.meal_id], async () => {
                      if (fix.type === 'recipe') {
                        await edit.mutateAsync({ kind: 'meal', row: { ...meal, recipe_id: fix.recipe_id } })
                        return
                      }
                      const variant = variantRecipe(doc, recipe, asking.item, fix, randomId)
                      await edit.mutateAsync({ kind: 'recipe', row: variant.row, lines: variant.lines, removed: [] })
                      await edit.mutateAsync({ kind: 'meal', row: { ...meal, recipe_id: variant.row.id } })
                    })
                  return <Row key={id} divider={i > 0} title={priced.title} detail={detail} icon={done.has(id) ? 'circle-check' : undefined} onPress={done.has(m.meal_id) || edit.isPending ? undefined : () => void use()} />
                })}
              </Card>
            </View>
          )
        })}
        {answer && answer.buy.length > 0 ? (
          <View style={{ gap: SPACE[2] }}>
            <Text variant="headline">Buy instead</Text>
            <Card flush>
              {answer.buy.map((b, i) => {
                const item = index.items.get(b.item_id)
                if (!item) return null
                const id = `buy:${b.item_id}`
                const price = item.price_minor === null ? 'No price' : money(item.price_minor * b.packs, settings.currency)
                return <Row key={id} divider={i > 0} title={`${b.packs} × ${item.name}`} detail={[done.has(id) ? 'Added to this trip' : null, b.note || null, price].filter(Boolean).join(' · ')} icon={done.has(id) ? 'circle-check' : undefined} onPress={done.has(id) || edit.isPending ? undefined : () => void apply([id], () => edit.mutateAsync({ kind: 'item_patch', id: item.id, patch: { wanted_on: asking.trip } }))} />
              })}
            </Card>
          </View>
        ) : null}
        {answer ? <Text variant="footnote" tone="text2">DeepSeek suggests; Waypoint works out every cost. An ingredient swap saves as a copy of the recipe, so the original stays as it was.</Text> : null}
      </View>
    </Sheet>
  )
}
