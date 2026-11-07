import { mealsDoc, type MealsDoc } from '@waypoint/core/meals'
import { starterDoc } from '@waypoint/core/meals-starter'
import { describe, expect, it } from 'vitest'
import { draftDoc, planEdits, recipeCosts } from './plan.model'

const SAT = '2026-10-24'

// Sunday's adobo for lunch and dinner, and Monday cooking twice.
function doc(): MealsDoc {
  return mealsDoc.parse({
    ...starterDoc({ meals: null, cleaning: null, care: null }, 'EUR', 5, 2),
    meals: [
      { id: 'sun', day: '2026-10-25', slot: 'lunch', recipe_id: 'adobo', leftovers: true },
      { id: 'mon-l', day: '2026-10-26', slot: 'lunch', recipe_id: 'fried-rice' },
      { id: 'mon-d', day: '2026-10-26', slot: 'dinner', recipe_id: 'salmon' },
    ],
  })
}

const plan = [
  { day: '2026-10-26', lunch_recipe_id: 'curry', leftovers: true, dinner_recipe_id: null },
  { day: '2026-10-27', lunch_recipe_id: 'mapo', leftovers: false, dinner_recipe_id: 'salmon' },
]

describe('plan this week in the app', () => {
  it('prices every live recipe as written for the helper, an unpriced one at nothing', () => {
    expect(recipeCosts(doc())).toMatchObject({ adobo: 0, curry: 0 })
    expect(Object.keys(recipeCosts(doc()))).toHaveLength(12)
  })

  it('reads the week with the draft in place: added to what is there, or the whole week replaced', () => {
    const days = (d: MealsDoc) => d.meals.map((m) => `${m.day.slice(8)}:${m.slot}:${m.recipe_id}`).sort()
    expect(days(draftDoc(doc(), plan, SAT, 'empty'))).toEqual(['25:lunch:adobo', '26:lunch:curry', '27:dinner:salmon', '27:lunch:mapo'])
    expect(days(draftDoc(doc(), plan, SAT, 'all'))).toEqual(['26:lunch:curry', '27:dinner:salmon', '27:lunch:mapo'])
  })

  it('saves the draft over the days it plans, clearing a dinner that lunch now covers, and with the whole week the days it leaves out', () => {
    let n = 0
    const id = () => `new${++n}`
    expect(planEdits(doc(), plan, SAT, 'empty', id)).toEqual([
      { kind: 'unmeal', ids: ['mon-d'] },
      { kind: 'meal', row: { id: 'mon-l', day: '2026-10-26', slot: 'lunch', recipe_id: 'curry', leftovers: true } },
      { kind: 'meal', row: { id: 'new1', day: '2026-10-27', slot: 'lunch', recipe_id: 'mapo', leftovers: false } },
      { kind: 'meal', row: { id: 'new2', day: '2026-10-27', slot: 'dinner', recipe_id: 'salmon', leftovers: false } },
    ])
    expect(planEdits(doc(), plan, SAT, 'all', id)[0]).toEqual({ kind: 'unmeal', ids: ['sun', 'mon-d'] })
  })

  it('cooks only a dinner on a day with no lunch, clearing the lunch the day had', () => {
    const dinnerOnly = [{ day: '2026-10-25', lunch_recipe_id: null, leftovers: false, dinner_recipe_id: 'curry' }]
    const days = (d: MealsDoc) => d.meals.map((m) => `${m.day.slice(8)}:${m.slot}:${m.recipe_id}`).sort()
    expect(days(draftDoc(doc(), dinnerOnly, SAT, 'empty'))).toEqual(['25:dinner:curry', '26:dinner:salmon', '26:lunch:fried-rice'])
    expect(planEdits(doc(), dinnerOnly, SAT, 'empty', () => 'new1')).toEqual([
      { kind: 'unmeal', ids: ['sun'] },
      { kind: 'meal', row: { id: 'new1', day: '2026-10-25', slot: 'dinner', recipe_id: 'curry', leftovers: false } },
    ])
  })
})
