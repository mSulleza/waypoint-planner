import { mealsDoc, type MealsDoc } from '@waypoint/core/meals'
import { starterDoc } from '@waypoint/core/meals-starter'
import { describe, expect, it } from 'vitest'
import { addDaysText, cookedLastWeek, daysToPlan, planPrompt, readPlan, readPlanRequest, type PlanRequest } from './meals-plan'

const SAT = '2026-10-24'

// The starter pack with Saturday's lunch from the fridge left out, adobo on Sunday, and curry cooked the week before.
function doc(): MealsDoc {
  return mealsDoc.parse({
    ...starterDoc({ meals: null, cleaning: null, care: null }, 'EUR', 5, 2),
    meals: [
      { id: 'sun', day: '2026-10-25', slot: 'lunch', recipe_id: 'adobo', leftovers: true },
      { id: 'old', day: '2026-10-20', slot: 'lunch', recipe_id: 'curry', leftovers: true },
    ],
  })
}

const REQ: PlanRequest = { task: 'plan', week: SAT, mode: 'empty', note: 'Saturday lunch from the fridge', budget_minor: 8600, currency: 'EUR', costs: { adobo: 1310, curry: 1800 } }

describe('plan this week', () => {
  it('reads a plan request with a real week, a mode, a budget and whole-cent costs, and nothing else', () => {
    expect(readPlanRequest({ ...REQ, note: '  x  ' })).toEqual({ ...REQ, note: 'x' })
    expect([readPlanRequest({ ...REQ, mode: 'some' }), readPlanRequest({ ...REQ, week: '2026-13-01' }), readPlanRequest({ ...REQ, costs: { adobo: 1.5 } }), readPlanRequest({ ...REQ, budget_minor: null })?.budget_minor]).toEqual([null, null, null, null])
  })

  it('plans the days with nothing planned yet, or all seven, and tells DeepSeek the budget, last week’s recipes and each recipe’s cost', () => {
    expect(daysToPlan(doc(), REQ)).toEqual(['2026-10-24', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'])
    // A day with only its dinner planned is not empty.
    const dinnerOnly = mealsDoc.parse({ ...doc(), meals: [...doc().meals, { id: 'tue-d', day: '2026-10-27', slot: 'dinner', recipe_id: 'salmon' }] })
    expect(daysToPlan(dinnerOnly, REQ)).not.toContain('2026-10-27')
    expect(daysToPlan(doc(), { ...REQ, mode: 'all' })).toHaveLength(7)
    const p = JSON.parse(planPrompt(doc(), REQ)) as { budget_eur: number; cooked_last_week: string[]; already_planned: { recipe: string }[]; recipes: { id: string; cost_eur: number | null; main: string | null }[]; note: string }
    expect([p.budget_eur, p.cooked_last_week, p.already_planned.map((m) => m.recipe), p.note]).toEqual([86, ['Coconut chicken curry'], ['Chicken adobo'], 'Saturday lunch from the fridge'])
    expect(p.recipes.find((r) => r.id === 'adobo')).toMatchObject({ cost_eur: 13.1, main: 'Chicken thighs, boneless' })
  })

  it('keeps one entry per day it may plan, with live recipes, and no dinner on a day that cooks for dinner too', () => {
    const answer = readPlan(
      {
        plan: [
          { day: '2026-10-27', lunch_recipe_id: 'mapo', leftovers: true, dinner_recipe_id: 'salmon' },
          { day: '2026-10-26', lunch_recipe_id: 'fried-rice', leftovers: false, dinner_recipe_id: 'salmon' },
          { day: '2026-10-25', lunch_recipe_id: 'curry', leftovers: true },
          { day: '2026-10-27', lunch_recipe_id: 'curry', leftovers: true },
          { day: '2026-10-28', lunch_recipe_id: 'lasagne', leftovers: true },
          { day: '2026-11-02', lunch_recipe_id: 'curry', leftovers: true },
        ],
        note: 'Under budget.',
      },
      doc(),
      REQ,
    )
    expect(answer).toEqual({
      plan: [
        { day: '2026-10-26', lunch_recipe_id: 'fried-rice', leftovers: false, dinner_recipe_id: 'salmon' },
        { day: '2026-10-27', lunch_recipe_id: 'mapo', leftovers: true, dinner_recipe_id: null },
      ],
      note: 'Under budget.',
    })
  })

  it('plans a dinner with no lunch cooked, and drops a day that cooks nothing', () => {
    const answer = readPlan(
      {
        plan: [
          { day: SAT, lunch_recipe_id: null, leftovers: true, dinner_recipe_id: 'salmon' },
          { day: '2026-10-26', lunch_recipe_id: null, leftovers: false, dinner_recipe_id: null },
          { day: '2026-10-27', dinner_recipe_id: 'mapo' },
        ],
      },
      doc(),
      REQ,
    )
    expect(answer.plan).toEqual([
      { day: SAT, lunch_recipe_id: null, leftovers: false, dinner_recipe_id: 'salmon' },
      { day: '2026-10-27', lunch_recipe_id: null, leftovers: false, dinner_recipe_id: 'mapo' },
    ])
  })

  it('counts last week from its shopping day to the day before this week’s', () => {
    const d = mealsDoc.parse({
      ...doc(),
      meals: [
        { id: 'a', day: '2026-10-16', slot: 'lunch', recipe_id: 'mapo', leftovers: true },
        { id: 'b', day: '2026-10-17', slot: 'lunch', recipe_id: 'teriyaki', leftovers: true },
        { id: 'c', day: '2026-10-23', slot: 'dinner', recipe_id: 'salmon' },
        { id: 'd', day: SAT, slot: 'lunch', recipe_id: 'pancit', leftovers: true },
      ],
    })
    // The week from Saturday 24 Oct follows Saturday 17 to Friday 23 Oct.
    expect([...cookedLastWeek(d, SAT)]).toEqual(['teriyaki', 'salmon'])
  })
})

describe('no recipe two weeks running', () => {
  const NEXT = '2026-10-31'
  const lunches = (ids: string[]) => ids.map((id, i) => ({ day: addDaysText(NEXT, i), lunch_recipe_id: id, leftovers: true }))

  // The week of 24 Oct as cooked: six lunches, each also dinner.
  function cooked(): MealsDoc {
    const ids = ['adobo', 'beef-broccoli', 'mapo', 'curry', 'pork-belly', 'fried-rice']
    return mealsDoc.parse({ ...doc(), meals: ids.map((id, i) => ({ id, day: addDaysText(SAT, i), slot: 'lunch', recipe_id: id, leftovers: true })) })
  }

  it('swaps a recipe cooked last week for one not yet in this week, and says so in the note', () => {
    // DeepSeek planned mapo again on Thursday 5 Nov; tofu stir-fry is the one recipe neither week has.
    const answer = readPlan({ plan: lunches(['teriyaki', 'pancit', 'salmon', 'tinola', 'kra-pao', 'mapo']), note: 'Under budget.' }, cooked(), { ...REQ, week: NEXT, mode: 'all' })
    expect(answer.plan.map((p) => p.lunch_recipe_id)).toEqual(['teriyaki', 'pancit', 'salmon', 'tinola', 'kra-pao', 'tofu-noodles'])
    expect(answer.note).toBe('Under budget. Thursday has Tofu stir-fry with rice noodles instead of Mapo-style tofu with pork, which was cooked last week.')
  })

  it('keeps a recipe from last week when every other one is already planned this week, and says so', () => {
    const plan = [...lunches(['teriyaki', 'pancit', 'salmon', 'tinola', 'kra-pao', 'tofu-noodles']), { day: '2026-11-06', lunch_recipe_id: null, leftovers: false, dinner_recipe_id: 'adobo' }]
    const answer = readPlan({ plan }, cooked(), { ...REQ, week: NEXT, mode: 'all' })
    expect(answer.plan.at(-1)).toEqual({ day: '2026-11-06', lunch_recipe_id: null, leftovers: false, dinner_recipe_id: 'adobo' })
    expect(answer.note).toBe('Friday has Chicken adobo again from last week: every other recipe is already planned this week.')
    // A meal already on the week counts as planned when only the empty days are planned.
    const kept = mealsDoc.parse({ ...cooked(), meals: [...cooked().meals, { id: 'fri', day: '2026-11-06', slot: 'lunch', recipe_id: 'tofu-noodles', leftovers: true }] })
    expect(readPlan({ plan: lunches(['teriyaki', 'pancit', 'salmon', 'tinola', 'kra-pao', 'mapo']) }, kept, { ...REQ, week: NEXT }).plan.at(-1)?.lunch_recipe_id).toBe('mapo')
  })
})
