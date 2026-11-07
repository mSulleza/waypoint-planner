import { Missing } from '@/shell/Missing'
import { ItemEditor, ItemsBody } from './Items'
import { PrintBody } from './Print'
import { RecipeEditor, RecipesBody } from './Recipes'
import { ShopBody } from './Shop'

// The meals page a /meals/<page>[/<id>] address names.
export function MealsPage({ path }: { path: readonly string[] }) {
  const [page, id] = path
  if (page === 'shop' && id === undefined) return <ShopBody />
  if (page === 'recipes' && id === undefined) return <RecipesBody />
  if (page === 'items' && id === undefined) return <ItemsBody />
  if (page === 'print' && id === undefined) return <PrintBody />
  if (page === 'recipe' && id !== undefined) return <RecipeEditor id={id} />
  if (page === 'item' && id !== undefined) return <ItemEditor id={id} />
  return <Missing what="meals page" list="/meals" listTitle="Meals" />
}
