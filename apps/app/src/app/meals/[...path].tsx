import { useLocalSearchParams } from 'expo-router'
import { Suspense } from 'react'
import { loadMeals } from '@/screens/meals/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Text } from '@/ui/Text'

const useBody = lazyPart<{ path: readonly string[] }>(
  () => loadMeals().then((m) => m.MealsPage),
  ({ retry }) => <NotLoaded what="This meals page" retry={retry} />,
)

const TITLES: Readonly<Record<string, string>> = { shop: 'Shopping list', recipes: 'Recipes', items: 'Price list', print: 'Print', recipe: 'Recipe', item: 'Item' }

// /meals/shop, /meals/recipes, /meals/items and /meals/print, and the editors at /meals/recipe/<id> and /meals/item/<id> (new adds one); one route file keeps the first load small.
export default function MealsPages() {
  const { path } = useLocalSearchParams<{ path: string[] }>()
  const parts = Array.isArray(path) ? path : [String(path ?? '')]
  const [page = '', id] = parts
  const title = id === 'new' ? `New ${page}` : (TITLES[page] ?? 'Meals')
  const Body = useBody()
  return (
    <Screen title={title} kind="page">
      <Suspense fallback={<Text tone="text2">Loading…</Text>}>
        <Body path={parts} />
      </Suspense>
    </Screen>
  )
}
