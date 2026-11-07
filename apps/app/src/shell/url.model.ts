import { addMonths, firstOfMonth, monthKey } from '@waypoint/core'

// Screen state lives in the URL: months?month=YYYY-MM&view=…&span=plan, an account in the path, Compare's levers after #l=.

// The plan item editor's address for an item not saved yet: /plan/item/new.
export const NEW_ITEM_ID = 'new'

// The account editor's address for an account not saved yet: /settings/account/new, with ?kind= to start it.
export const NEW_ACCOUNT_ID = 'new'

export const MONTH_VIEWS = ['todo', 'breakdown', 'chart'] as const
export type MonthView = (typeof MONTH_VIEWS)[number]

type Param = string | string[] | undefined

function one(value: Param): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function isMonth(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

// Read only from the URL: without a valid month or view the screen shows the household's current month and To-do, at any screen size.
export function monthsState(params: { month?: Param; view?: Param }, today: string): { month: string; view: MonthView } {
  const month = one(params.month)
  const view = one(params.view)
  return { month: isMonth(month) ? month : monthKey(today), view: MONTH_VIEWS.find((v) => v === view) ?? 'todo' }
}

// The chart's span: the selected month, or the whole plan with ?span=plan.
export type ChartSpan = 'month' | 'plan'

export function chartSpan(span: Param): ChartSpan {
  return one(span) === 'plan' ? 'plan' : 'month'
}

export function stepMonth(month: string, by: number): string {
  return monthKey(addMonths(firstOfMonth(month), by))
}

export function monthTitle(month: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))
}

// 'Nov 2027': a month where a full name would wrap, such as the hero's figure; screen readers still hear monthTitle.
export function shortMonth(month: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))
}

// The levers part of Compare's fragment (#l=…), which browsers never send to a server; null when the link has none.
export function leverFragment(hash: Param): string | null {
  const text = one(hash)
  if (!text) return null
  const value = new URLSearchParams(text.startsWith('#') ? text.slice(1) : text).get('l')
  return value ? value : null
}
