import type { ItemKind, MealsDocInput, Unit } from './meals'

// The starter pack a household with no meals can add: quick Asian recipes for 4 (lunch and dinner for two) and the items they use, linked to Mercadona products and never priced, so each household's prices are its own.

export type StarterBudget = 'meals' | 'cleaning' | 'personal care'

export interface StarterItem {
  key: string
  name: string
  kind: ItemKind
  unit: Unit
  pack_size: number
  mercadona_id: string
  aisle: string
  lasts_days?: number
  budget: StarterBudget
}

export interface StarterRecipe {
  key: string
  name: string
  prep_minutes: number
  steps: string
  // [item key, quantity for 4 portions in the item's unit]
  lines: readonly (readonly [string, number])[]
}

const MEAT = 'Meat'
const FISH = 'Fish and seafood'
const VEG = 'Fruit and veg'
const FROZEN = 'Frozen'
const CHILLED = 'Chilled'
const DRY = 'Rice, pasta and noodles'
const SAUCES = 'Oil, sauces and spices'
const DAIRY = 'Eggs and milk'
const CLEANING = 'Cleaning'
const CARE = 'Personal care'

const recipe = (key: string, name: string, unit: Unit, pack_size: number, mercadona_id: string, aisle: string): StarterItem => ({ key, name, kind: 'recipe', unit, pack_size, mercadona_id, aisle, budget: 'meals' })
const stock = (key: string, name: string, unit: Unit, pack_size: number, mercadona_id: string, aisle: string, lasts_days: number, budget: StarterBudget = 'meals'): StarterItem => ({ key, name, kind: 'stock', unit, pack_size, mercadona_id, aisle, lasts_days, budget })

export const STARTER_ITEMS: readonly StarterItem[] = [
  recipe('thighs', 'Chicken thighs, boneless', 'g', 620, '2789', MEAT),
  recipe('breast', 'Chicken breasts', 'g', 610, '3724', MEAT),
  recipe('pork-mince', 'Pork mince', 'g', 500, '2867', MEAT),
  recipe('pork-belly', 'Pork belly, thin slices', 'g', 500, '8994', MEAT),
  recipe('beef', 'Beef steaks for frying', 'g', 500, '2900', MEAT),
  recipe('salmon', 'Salmon portions', 'g', 350, '87204', FISH),
  recipe('prawns', 'Raw peeled prawns, frozen', 'g', 360, '24181', FROZEN),
  recipe('tofu', 'Firm tofu', 'g', 400, '51097', CHILLED),
  recipe('spring-onions', 'Spring onions', 'unit', 1, '69139', VEG),
  recipe('broccoli', 'Broccoli', 'g', 420, '69580', VEG),
  recipe('cabbage', 'White cabbage, half', 'g', 900, '68462', VEG),
  recipe('cucumber', 'Cucumber', 'unit', 1, '69584', VEG),
  recipe('courgette', 'Courgette', 'unit', 1, '69338', VEG),
  recipe('red-pepper', 'Red pepper', 'unit', 1, '69310', VEG),
  recipe('spinach', 'Spinach, washed', 'g', 300, '69730', VEG),
  recipe('lime', 'Lime', 'unit', 1, '3897', VEG),
  recipe('wok-veg', 'Stir-fry vegetables, frozen', 'g', 450, '11617', FROZEN),
  recipe('coconut', 'Coconut milk', 'ml', 400, '17174', SAUCES),
  recipe('rice-noodles', 'Rice noodles', 'g', 200, '35981', DRY),
  recipe('ramen', 'Ramen noodles', 'g', 200, '9861', DRY),
  stock('rice', 'Long-grain rice', 'g', 1000, '5063', DRY, 7),
  stock('soy', 'Soy sauce', 'ml', 250, '17360', SAUCES, 21),
  stock('teriyaki', 'Teriyaki sauce', 'ml', 250, '17362', SAUCES, 45),
  stock('sweet-chili', 'Sweet chili sauce', 'ml', 250, '22613', SAUCES, 60),
  stock('oil', 'Olive oil', 'ml', 1000, '4240', SAUCES, 30),
  stock('vinegar', 'White wine vinegar', 'ml', 1000, '4940', SAUCES, 120),
  stock('honey', 'Honey', 'g', 500, '15430', SAUCES, 60),
  stock('cornflour', 'Cornflour', 'g', 400, '9588', SAUCES, 120),
  stock('curry', 'Curry powder', 'g', 57, '34125', SAUCES, 120),
  stock('pepper', 'Black pepper, ground', 'g', 70, '34171', SAUCES, 120),
  stock('paprika', 'Hot paprika', 'g', 60, '34183', SAUCES, 120),
  stock('bay', 'Bay leaves', 'g', 12, '47994', SAUCES, 180),
  stock('stock', 'Chicken stock', 'ml', 1000, '7313', SAUCES, 21),
  stock('garlic', 'Garlic', 'g', 250, '69297', VEG, 21),
  stock('ginger', 'Fresh ginger', 'g', 200, '69289', VEG, 21),
  stock('onions', 'Onions', 'g', 1000, '69089', VEG, 14),
  stock('carrots', 'Carrots', 'g', 1000, '69586', VEG, 14),
  stock('peas', 'Peas, frozen', 'g', 1000, '61215', FROZEN, 30),
  stock('eggs', 'Eggs, large', 'unit', 12, '31504', DAIRY, 7),
  stock('milk', 'Semi-skimmed milk, 6 cartons', 'ml', 6000, '10381', DAIRY, 7),
  stock('dish-soap', 'Washing-up liquid', 'ml', 1300, '42441', CLEANING, 45, 'cleaning'),
  stock('laundry', 'Laundry pods', 'unit', 24, '23440', CLEANING, 42, 'cleaning'),
  stock('toilet-paper', 'Toilet paper rolls', 'unit', 12, '47835', CLEANING, 28, 'cleaning'),
  stock('shampoo', 'Shampoo', 'ml', 1000, '35419', CARE, 60, 'personal care'),
  stock('shower-gel', 'Shower gel', 'ml', 750, '46567', CARE, 30, 'personal care'),
  stock('toothpaste', 'Toothpaste', 'ml', 100, '46724', CARE, 30, 'personal care'),
]

export const STARTER_RECIPES: readonly StarterRecipe[] = [
  {
    key: 'adobo',
    name: 'Chicken adobo',
    prep_minutes: 30,
    steps: '1. Brown the chicken in the oil.\n2. Add garlic, soy, vinegar, bay and pepper with 200 ml water.\n3. Simmer 20 minutes, lid off for the last 5, until the sauce is glossy.\n4. Serve with rice.',
    lines: [['thighs', 620], ['soy', 60], ['vinegar', 60], ['garlic', 25], ['bay', 0.6], ['pepper', 2], ['oil', 15], ['rice', 300]],
  },
  {
    key: 'teriyaki',
    name: 'Chicken teriyaki with broccoli',
    prep_minutes: 25,
    steps: '1. Cut the chicken into strips and the broccoli into florets.\n2. Fry the chicken until golden, add garlic and broccoli with a splash of water and cover 3 minutes.\n3. Pour in the teriyaki and toss until sticky.\n4. Top with spring onion; serve with rice.',
    lines: [['breast', 610], ['broccoli', 420], ['teriyaki', 80], ['garlic', 10], ['oil', 15], ['spring-onions', 0.5], ['rice', 300]],
  },
  {
    key: 'mapo',
    name: 'Mapo-style tofu with pork',
    prep_minutes: 25,
    steps: '1. Cut the tofu into 2 cm cubes.\n2. Fry the pork mince in the oil until browned and a little crisp, then garlic and ginger for a minute.\n3. Take the pan off the heat and stir in the hot paprika for 20 seconds, until the oil turns red; it burns fast.\n4. Back on the heat, add stock, soy and the tofu; simmer 5 minutes, nudging the tofu rather than stirring.\n5. Thicken with the cornflour mixed in a little water, in two or three goes.\n6. Top with black pepper and spring onion; serve with rice.',
    lines: [['tofu', 400], ['pork-mince', 250], ['garlic', 10], ['ginger', 15], ['paprika', 10], ['soy', 45], ['stock', 200], ['cornflour', 10], ['pepper', 2], ['spring-onions', 0.5], ['oil', 30], ['rice', 300]],
  },
  {
    key: 'pancit',
    name: 'Pancit-style noodles with pork and cabbage',
    prep_minutes: 25,
    steps: '1. Soak the noodles in hot water 3 minutes and drain.\n2. Fry the pork until crisp, then onion, garlic and carrot.\n3. Add cabbage, stock and soy; bring to the boil.\n4. Add the noodles and toss until the liquid is taken up. Squeeze lime over.',
    lines: [['ramen', 400], ['pork-belly', 250], ['cabbage', 300], ['carrots', 150], ['onions', 150], ['garlic', 10], ['soy', 60], ['stock', 250], ['oil', 15], ['lime', 1]],
  },
  {
    key: 'curry',
    name: 'Coconut chicken curry',
    prep_minutes: 30,
    steps: '1. Soften onion, garlic and ginger in the oil.\n2. Add the curry powder for 30 seconds, then the chicken in pieces.\n3. Pour in the coconut milk with the pepper in strips; simmer 15 minutes.\n4. Serve with rice.',
    lines: [['thighs', 620], ['coconut', 400], ['curry', 15], ['onions', 150], ['red-pepper', 1], ['garlic', 10], ['ginger', 10], ['oil', 15], ['rice', 300]],
  },
  {
    key: 'fried-rice',
    name: 'Prawn egg fried rice',
    prep_minutes: 20,
    steps: '1. Cook the rice ahead and spread it to cool (day-old rice fries best).\n2. Fry the prawns in half the oil and set aside.\n3. Scramble the eggs, add garlic, peas and the rice; fry hard 4 minutes.\n4. Return the prawns, add soy and spring onion.',
    lines: [['prawns', 360], ['eggs', 4], ['rice', 400], ['peas', 150], ['spring-onions', 1], ['soy', 45], ['garlic', 10], ['oil', 30]],
  },
  {
    key: 'salmon',
    name: 'Ginger-soy salmon with cucumber salad',
    prep_minutes: 20,
    steps: '1. Mix soy, honey, grated ginger and garlic.\n2. Pan-fry the salmon skin side down 4 minutes, turn, pour in the sauce and cook 2 more.\n3. Slice the cucumber and dress it with vinegar and a pinch of salt.\n4. Serve with rice.',
    lines: [['salmon', 700], ['soy', 45], ['honey', 30], ['ginger', 15], ['garlic', 5], ['cucumber', 2], ['vinegar', 20], ['rice', 300]],
  },
  {
    key: 'beef-broccoli',
    name: 'Beef and broccoli',
    prep_minutes: 20,
    steps: '1. Slice the beef thin and toss with half the cornflour.\n2. Sear it in batches in a very hot pan; set aside.\n3. Fry garlic, ginger and broccoli with a splash of water, covered 3 minutes.\n4. Add soy, honey and the rest of the cornflour in water; return the beef. Serve with rice.',
    lines: [['beef', 500], ['broccoli', 420], ['soy', 60], ['honey', 15], ['cornflour', 10], ['garlic', 10], ['ginger', 10], ['oil', 15], ['rice', 300]],
  },
  {
    key: 'pork-belly',
    name: 'Honey-garlic pork belly',
    prep_minutes: 25,
    steps: '1. Fry the pork slices until crisp; pour off most of the fat.\n2. Add garlic, then soy, honey and sweet chili; toss until glazed.\n3. Slice the cucumber on the side.\n4. Top with spring onion; serve with rice.',
    lines: [['pork-belly', 500], ['garlic', 15], ['soy', 45], ['honey', 30], ['sweet-chili', 30], ['spring-onions', 0.5], ['cucumber', 1], ['rice', 300]],
  },
  {
    key: 'tinola',
    name: 'Chicken tinola (ginger soup)',
    prep_minutes: 30,
    steps: '1. Soften onion, garlic and ginger in strips.\n2. Add the chicken in pieces and fry 3 minutes.\n3. Pour in the stock, bring to the boil and simmer 15 minutes.\n4. Add courgette in chunks for 5 minutes, then the spinach. Pepper to taste; serve with rice.',
    lines: [['thighs', 620], ['ginger', 30], ['onions', 150], ['garlic', 10], ['courgette', 2], ['spinach', 150], ['stock', 1000], ['pepper', 1], ['oil', 15], ['rice', 300]],
  },
  {
    key: 'tofu-noodles',
    name: 'Tofu stir-fry with rice noodles',
    prep_minutes: 20,
    steps: '1. Soak the noodles in hot water 5 minutes and drain.\n2. Fry the tofu in cubes until golden; set aside.\n3. Fry garlic and the vegetables from frozen, 5 minutes.\n4. Add noodles, tofu, soy and sweet chili; toss. Squeeze lime over.',
    lines: [['tofu', 400], ['rice-noodles', 200], ['wok-veg', 450], ['soy', 45], ['sweet-chili', 45], ['garlic', 10], ['oil', 30], ['lime', 1]],
  },
  {
    key: 'kra-pao',
    name: 'Garlic-pepper pork mince with fried egg',
    prep_minutes: 20,
    steps: '1. Fry garlic and the pepper in strips 1 minute.\n2. Add the pork mince and break it up until browned.\n3. Season with soy and honey.\n4. Fry the eggs crisp and serve on rice with the pork.',
    lines: [['pork-mince', 500], ['red-pepper', 1], ['garlic', 15], ['soy', 30], ['honey', 10], ['eggs', 4], ['oil', 30], ['rice', 300]],
  },
]

export interface StarterCategories {
  meals: string | null
  cleaning: string | null
  care: string | null
}

// The pack as import_meals takes it, with document ids and the household's own allowances.
export function starterDoc(categories: StarterCategories, currency: string, shopWeekday: number, people: number): MealsDocInput {
  const category = (b: StarterBudget) => (b === 'cleaning' ? categories.cleaning : b === 'personal care' ? categories.care : null)
  return {
    settings: { category_id: categories.meals, currency, shop_weekday: shopWeekday, people },
    items: STARTER_ITEMS.map((i) => ({ id: i.key, name: i.name, kind: i.kind, unit: i.unit, pack_size: i.pack_size, mercadona_id: i.mercadona_id, aisle: i.aisle, lasts_days: i.lasts_days ?? null, category_id: category(i.budget) })),
    recipes: STARTER_RECIPES.map((r) => ({ id: r.key, name: r.name, portions: 4, prep_minutes: r.prep_minutes, steps: r.steps })),
    recipe_items: STARTER_RECIPES.flatMap((r) => r.lines.map(([item, quantity], i) => ({ id: `${r.key}:${item}`, recipe_id: r.key, item_id: item, quantity, sort_order: i }))),
  }
}
