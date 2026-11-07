import type { CompareResult, Lever, Total } from '@waypoint/core'
import { compare as compareLevers, encodeLevers } from '@waypoint/core/compare'
import { compareInput } from '@waypoint/core/agent'
import { amount, AMOUNTS, basis, DATA_TEXT, type ReadTool } from './read/shape'

// Node has no screen to hand back to between walks.
const pause = () => Promise.resolve()

const total = (t: Total | null) => t && { ...amount(t.minor, t.currency), approx: t.approx, ...(t.approx ? { rates_day: t.day } : {}) }

function rowOf(row: CompareResult) {
  if (!row.ok) return { role: row.role, ok: false, errors: row.errors, data_text: { label: row.label } }
  return {
    role: row.role,
    ok: true,
    net_worth: total(row.net_worth),
    delta_net_worth: total(row.delta_net_worth),
    lowest_by_account: row.lowest_by_account.map((l) => ({ account_id: l.account_id, lowest: amount(l.lowest_minor, l.currency), lowest_on: l.lowest_on, delta: amount(l.delta_minor, l.currency) })),
    days_under_floor: row.days_under_floor,
    delta_days_under_floor: row.delta_days_under_floor,
    months_under_target: row.months_under_target,
    delta_months_under_target: row.delta_months_under_target,
    fx_margin: row.fx_margin,
    delta_fx_margin: row.delta_fx_margin,
    debt_free_month: row.debt_free_month,
    debt_free_after_horizon: row.debt_free_after_horizon,
    delta_debt_free_months: row.delta_debt_free_months,
    interest: row.interest.map((i) => ({ account_id: i.account_id, interest: amount(i.interest_minor, i.currency), delta: amount(i.delta_minor, i.currency) })),
    interest_total: total(row.interest_total),
    delta_interest_total: total(row.delta_interest_total),
    moved: row.moved,
    data_text: { label: row.label },
  }
}

export const compareTool: ReadTool<typeof compareInput> = {
  name: 'compare',
  description: [
    'Prices decisions without saving anything: the baseline, each patch on its own and, with two or more, all of them together, each walked by the engine on the same household (core compare).',
    'A patch is core’s: fx_shift_pct (a fraction, −0.1 makes the funding currency 10% weaker), items {plan item id: {amount_minor and day from from_month (YYYY-MM), ends_on, removed, include_upside}}, add (new plan items in full), accounts {id: {floor_windows}} and income_gap {from_month, months, item_ids?}. Amounts in a patch are whole minor units.',
    'Each row gives net worth at the projection’s end, each cash account’s lowest balance, days under floor, months under target, FX margin, debt-free month and interest, with the change from the baseline and which figures moved.',
    'link opens the same comparison in the web app’s Compare screen.',
    AMOUNTS,
    DATA_TEXT,
  ].join(' '),
  input: compareInput,
  async run(world, args) {
    const levers: Lever[] = args.patches.map((p) => ({ label: p.label, patch: p.patch }))
    const rows: CompareResult[] = []
    for await (const row of compareLevers(world.snapshot, levers, { pause })) rows.push(row)
    return {
      basis: basis(world),
      rows: rows.map(rowOf),
      link: world.web_url === null ? null : `${world.web_url}/plan/compare#l=${encodeLevers(levers)}`,
    }
  },
}
