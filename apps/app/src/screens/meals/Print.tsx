import type { Snapshot } from '@waypoint/core'
import type { Cook, DayPlan, MealsDoc, MealSettings, TripList } from '@waypoint/core/meals'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { createElement as h, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { View } from 'react-native'
import { Button } from '@/ui/Button'
import { Choices } from '@/ui/Choices'
import { useMoneyText } from '@/ui/Money'
import { Text } from '@/ui/Text'
import { useLocale } from '@/ui/theme'
import { SPACE } from '@/ui/tokens'
import { useMeals } from './data'
import { buyWords, byAisle, dayName, ingredientWords, reasonWords, weekFromParam, weekRange, weekView } from './meals.model'
import { LoadFailed } from './parts'

// The printout: the week on one landscape page with its recipes and shopping list, or a page a day with its menu, ingredients and steps. Printing hides the app and prints only these pages.

const STYLE_ID = 'waypoint-meals-print'
const PAGE_STYLE_ID = 'waypoint-meals-print-page'
const PORTAL_CLASS = 'wp-print-portal'

// A4 landscape inside 8 mm margins, less 2 mm so a rounding never spills onto a second sheet.
const CAL_W_MM = 281
const CAL_H_MM = 192
const MM_PX = 96 / 25.4
// The calendar's text starts at the largest size and shrinks in quarter points until the page holds everything.
const FIT_MAX_PT = 9.5
const FIT_MIN_PT = 5.5

const CSS = [
  `.${PORTAL_CLASS} { position: fixed; top: 0; left: -10000px; visibility: hidden; pointer-events: none; }`,
  `.wp-doc { color: #111; font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.45; }`,
  `.wp-preview .wp-page { background: #fff; border: 1px solid #d0d0d0; border-radius: 8px; padding: 18px; margin-bottom: 16px; }`,
  `.wp-page h1 { font-size: 18pt; margin: 0 0 2px; }`,
  `.wp-page h2 { font-size: 13pt; margin: 16px 0 4px; border-bottom: 1px solid #bbb; padding-bottom: 2px; }`,
  `.wp-page h3 { font-size: 11pt; margin: 10px 0 2px; color: #444; }`,
  `.wp-page p { margin: 2px 0; }`,
  `.wp-page ul, .wp-page ol { margin: 4px 0 4px 20px; padding: 0; }`,
  `.wp-page .wp-meta { color: #555; font-size: 9.5pt; }`,
  `.wp-page .wp-todo { border: 2px solid #111; border-radius: 6px; padding: 8px 12px; margin-top: 10px; }`,
  `.wp-page .wp-todo ul { list-style: none; margin-left: 0; }`,
  `.wp-page .wp-todo li { display: flex; gap: 8px; align-items: baseline; }`,
  `.wp-page .wp-box { display: inline-block; width: 10pt; height: 10pt; border: 1.2pt solid #111; flex: none; transform: translateY(1pt); }`,
  `.wp-page .wp-cost { margin-left: auto; white-space: nowrap; font-variant-numeric: tabular-nums; }`,
  `.wp-cal { box-sizing: border-box; width: ${CAL_W_MM}mm; height: ${CAL_H_MM}mm; overflow: hidden; display: flex; flex-direction: column; line-height: 1.3; }`,
  `.wp-cal .wp-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; border-bottom: 1.5px solid #0f6e56; }`,
  `.wp-cal h1 { font-family: Georgia, 'Times New Roman', serif; font-weight: 400; font-size: 2em; letter-spacing: -0.5px; margin: 0; }`,
  `.wp-cal .wp-sum { text-align: right; font-size: 0.95em; color: #444; }`,
  `.wp-cal .wp-grid { flex: 1 0 auto; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }`,
  `.wp-cal .wp-day { padding: 0.4em 0.6em; border-left: 1px dotted #9a9a9a; overflow-wrap: anywhere; }`,
  `.wp-cal .wp-day:first-child { border-left: none; padding-left: 0; }`,
  `.wp-cal .wp-date { display: flex; align-items: baseline; gap: 0.4em; }`,
  `.wp-cal .wp-num { font-family: Georgia, serif; font-size: 2.2em; line-height: 1; color: transparent; -webkit-text-stroke: 0.7px #222; }`,
  `.wp-cal .wp-wd { font-size: 0.8em; letter-spacing: 1.2px; text-transform: uppercase; color: #555; }`,
  `.wp-cal svg { flex: none; width: 1.1em; height: 1.1em; stroke: #555; fill: none; stroke-width: 1.6; }`,
  `.wp-cal .wp-shop { display: flex; gap: 0.3em; align-items: center; font-size: 0.85em; color: #0f6e56; }`,
  `.wp-cal .wp-shop svg { stroke: #0f6e56; }`,
  `.wp-cal .wp-slot { display: flex; gap: 0.4em; align-items: flex-start; margin-top: 0.5em; }`,
  `.wp-cal .wp-dish { font-weight: 600; font-size: 1.05em; line-height: 1.25; }`,
  `.wp-cal .wp-again { font-style: italic; color: #555; font-weight: 400; }`,
  `.wp-cal .wp-meta { font-size: 0.85em; color: #666; }`,
  `.wp-cal .wp-recipe { margin-top: 0.6em; border-top: 1px dotted #b5b5b5; font-size: 0.9em; }`,
  `.wp-cal .wp-label { font-size: 0.8em; letter-spacing: 1px; text-transform: uppercase; color: #0f6e56; margin-top: 0.4em; }`,
  `.wp-cal .wp-recipe p { margin: 0.1em 0 0; }`,
  `.wp-cal .wp-recipe ol { margin: 0.1em 0 0 1.3em; padding: 0; }`,
  `.wp-cal .wp-list { border-top: 1.5px solid #0f6e56; margin-top: 0.3em; }`,
  `.wp-cal .wp-list-head { display: flex; justify-content: space-between; gap: 12px; font-weight: 600; margin-top: 0.3em; }`,
  `.wp-cal .wp-cols { column-count: 6; column-gap: 0.9em; }`,
  `.wp-cal .wp-aisle { font-size: 0.75em; letter-spacing: 1px; text-transform: uppercase; color: #0f6e56; break-after: avoid; margin-top: 0.3em; }`,
  `.wp-cal .wp-item { display: flex; gap: 0.4em; align-items: baseline; break-inside: avoid; }`,
  `.wp-cal .wp-box { display: inline-block; width: 0.8em; height: 0.8em; border: 1px solid #111; flex: none; }`,
  `.wp-preview .wp-cal { background: #fff; box-shadow: 0 0 0 1px #d0d0d0; transform-origin: top left; }`,
  `@media print {`,
  `  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }`,
  `  body > *:not(.${PORTAL_CLASS}) { display: none !important; }`,
  `  .${PORTAL_CLASS} { position: static !important; visibility: visible !important; }`,
  `  .wp-page { break-after: page; }`,
  `  .wp-page:last-child { break-after: auto; }`,
  `}`,
].join('\n')

function useStyle() {
  useEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  }, [])
}

// The sheet's size follows the choice: landscape for the week, portrait for the day pages.
function usePageSize(landscape: boolean) {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const style = document.createElement('style')
    style.id = PAGE_STYLE_ID
    style.textContent = `@media print { @page { size: A4${landscape ? ' landscape' : ''}; margin: ${landscape ? 8 : 14}mm; } }`
    document.head.appendChild(style)
    return () => style.remove()
  }, [landscape])
}

// A container under the body, outside the app's scrolling view, so every page prints and not only the part on screen. Off screen it keeps print size, so the calendar can be measured.
function usePortal(): HTMLElement | null {
  const [node, setNode] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const div = document.createElement('div')
    div.className = PORTAL_CLASS
    document.body.appendChild(div)
    setNode(div)
    return () => div.remove()
  }, [])
  return node
}

// The largest text size, in points, at which the calendar page holds everything.
function fitSize(page: HTMLElement): number {
  let pt = FIT_MAX_PT
  page.style.fontSize = `${pt}pt`
  while (pt > FIT_MIN_PT && page.scrollHeight > page.clientHeight) {
    pt -= 0.25
    page.style.fontSize = `${pt}pt`
  }
  return pt
}

const stepsOf = (cook: Cook) =>
  cook.recipe.steps
    .split('\n')
    .map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean)

interface PageProps {
  d: DayPlan
  trip: TripList | undefined
  week: string
  money: (minor: number) => string
  people: number
  locale: string
}

function MealBlock({ title, cook, people, locale }: { title: string; cook: Cook; people: number; locale: string }) {
  const portions = cook.meal.leftovers ? `${cook.cost.portions} portions, ${people} for lunch and ${people} for dinner` : `${cook.cost.portions} portions`
  const steps = stepsOf(cook)
  return h(
    'div',
    null,
    h('h2', null, `${title}: ${cook.recipe.name}`),
    h('p', { className: 'wp-meta' }, `${cook.recipe.prep_minutes} minutes · ${portions}`),
    h('h3', null, 'Ingredients'),
    h('ul', null, ...cook.cost.ingredients.map((i) => h('li', { key: i.item.id }, ingredientWords(i.item, i.quantity, locale)))),
    steps.length > 0 ? h('h3', null, 'Steps') : null,
    steps.length > 0 ? h('ol', null, ...steps.map((s, n) => h('li', { key: n }, s))) : null,
  )
}

function Page({ d, trip, week, money, people, locale }: PageProps) {
  const lines = trip?.lines.filter((l) => !l.unavailable && !l.at_home) ?? []
  const todo = trip && lines.length > 0
  return h(
    'section',
    { className: 'wp-page' },
    h('h1', null, dayName(d.day, locale)),
    h('p', { className: 'wp-meta' }, `Week of ${week}`),
    todo
      ? h(
          'div',
          { className: 'wp-todo' },
          h('h2', { style: { marginTop: 0, borderBottom: 'none' } }, `To do today: shopping, about ${money(trip.cost_minor)}${trip.missing > 0 ? ` (${trip.missing} without a price)` : ''}`),
          ...byAisle(lines).flatMap((g) => [
            h('h3', { key: `a-${g.aisle}` }, g.aisle),
            h(
              'ul',
              { key: `l-${g.aisle}` },
              ...g.lines.map((l) =>
                h(
                  'li',
                  { key: l.item.id },
                  h('span', { className: 'wp-box' }),
                  h('span', null, buyWords(l, locale), h('span', { className: 'wp-meta' }, ` · ${l.reasons.map((r) => reasonWords(r, locale)).join('; ')}`)),
                  h('span', { className: 'wp-cost' }, l.cost_minor === null ? '—' : money(l.cost_minor)),
                ),
              ),
            ),
          ]),
        )
      : null,
    d.lunch ? h(MealBlock, { title: 'Lunch', cook: d.lunch, people, locale }) : h('h2', null, 'Lunch: nothing planned'),
    d.dinner === 'leftovers' ? h('h2', null, 'Dinner: lunch again, no cooking') : d.dinner ? h(MealBlock, { title: 'Dinner', cook: d.dinner, people, locale }) : h('h2', null, 'Dinner: nothing planned'),
  )
}

// Lucide outline icons (ISC), stroke only, so they print as thin lines.
const ICON_PATHS: Readonly<Record<'sun' | 'moon' | 'cart', readonly string[]>> = {
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  cart: ['M8 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M19 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12'],
}
const icon = (name: keyof typeof ICON_PATHS) => h('svg', { viewBox: '0 0 24 24', 'aria-hidden': true }, ...ICON_PATHS[name].map((d, i) => h('path', { key: i, d })))

interface CalendarProps {
  days: readonly DayPlan[]
  trips: readonly TripList[]
  week: string
  budget: string | null
  money: (minor: number) => string
  locale: string
}

// The week on one landscape page: a column a day with its meals and recipes, then each trip's list as a to-do. A recipe cooked again points back to the day it is written on. Lines and outlines only, to save ink.
function CalendarPage({ days, trips, week, budget, money, locale }: CalendarProps) {
  const written = new Map<string, string>()
  const recipe = (cook: Cook, title: string | null, day: string) => {
    const key = `${cook.recipe.id}:${cook.cost.portions}`
    const first = written.get(key)
    if (first) return h('div', { key, className: 'wp-recipe wp-meta' }, `${cook.recipe.name}: recipe on ${first}`)
    written.set(key, new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`)))
    const steps = stepsOf(cook)
    return h(
      'div',
      { key, className: 'wp-recipe' },
      title ? h('div', { className: 'wp-label' }, title) : null,
      h('div', { className: 'wp-label' }, `Ingredients · ${cook.recipe.prep_minutes} min · ${cook.cost.portions} portions`),
      h('p', null, cook.cost.ingredients.map((i) => ingredientWords(i.item, i.quantity, locale)).join(' · ')),
      steps.length > 0 ? h('div', { className: 'wp-label' }, 'Steps') : null,
      steps.length > 0 ? h('ol', null, ...steps.map((s, n) => h('li', { key: n }, s))) : null,
    )
  }
  const dish = (c: Cook | null) => (c ? h('div', { className: 'wp-dish' }, c.recipe.name) : h('div', { className: 'wp-dish wp-again' }, 'Nothing planned'))
  const total = trips.reduce((s, t) => s + t.cost_minor, 0)
  const lists = trips.map((t) => ({ trip: t, lines: t.lines.filter((l) => !l.unavailable && !l.at_home) })).filter((t) => t.lines.length > 0)
  return h(
    'section',
    { className: 'wp-cal' },
    h('div', { className: 'wp-head' }, h('h1', null, `Meals · ${week}`), h('div', { className: 'wp-sum' }, `Shopping ${money(total)}${budget ? ` of ${budget}` : ''}`)),
    h(
      'div',
      { className: 'wp-grid' },
      ...days.map((d) => {
        const trip = lists.find((t) => t.trip.day === d.day)
        const date = new Date(`${d.day}T00:00:00Z`)
        const dinner = d.dinner === 'leftovers' ? null : d.dinner
        const twice = Boolean(d.lunch && dinner)
        return h(
          'div',
          { key: d.day, className: 'wp-day' },
          h('div', { className: 'wp-date' }, h('span', { className: 'wp-num' }, String(date.getUTCDate())), h('span', { className: 'wp-wd' }, new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(date))),
          trip ? h('div', { className: 'wp-shop' }, icon('cart'), `Shop · ${trip.lines.length} items`) : null,
          h('div', { className: 'wp-slot' }, icon('sun'), h('div', null, dish(d.lunch), d.lunch?.meal.leftovers ? h('div', { className: 'wp-meta' }, 'for dinner too') : null)),
          h('div', { className: 'wp-slot' }, icon('moon'), d.dinner === 'leftovers' ? h('div', { className: 'wp-dish wp-again' }, 'Lunch again') : dish(dinner)),
          d.lunch ? recipe(d.lunch, twice ? 'Lunch' : null, d.day) : null,
          dinner ? recipe(dinner, twice ? 'Dinner' : null, d.day) : null,
        )
      }),
    ),
    ...lists.map(({ trip, lines }) =>
      h(
        'div',
        { key: trip.day, className: 'wp-list' },
        h('div', { className: 'wp-list-head' }, h('span', null, `Shopping · ${dayName(trip.day, locale)}`), h('span', null, `about ${money(trip.cost_minor)}${trip.missing > 0 ? ` · ${trip.missing} without a price` : ''}`)),
        h(
          'div',
          { className: 'wp-cols' },
          ...byAisle(lines).flatMap((g) => [
            h('div', { key: `a-${g.aisle}`, className: 'wp-aisle' }, g.aisle),
            ...g.lines.map((l) => h('div', { key: l.item.id, className: 'wp-item' }, h('span', { className: 'wp-box' }), h('span', null, buyWords(l, locale)))),
          ]),
        ),
      ),
    ),
  )
}

function Doc({ pages, preview }: { pages: readonly PageProps[]; preview: boolean }): ReactNode {
  return h('div', { className: preview ? 'wp-doc wp-preview' : 'wp-doc' }, ...pages.map((p) => h(Page, { key: p.d.day, ...p })))
}

export function PrintBody() {
  const params = useLocalSearchParams<{ week?: string; day?: string }>()
  const { doc, settings, snapshot, error, refetch } = useMeals()
  if (error) return <LoadFailed error={error} retry={refetch} />
  if (!doc || !settings || !snapshot) return <Text tone="text2">Loading…</Text>
  const start = weekFromParam(params.week, snapshot.as_of, settings.shop_weekday)
  return <Printable doc={doc} settings={settings} snapshot={snapshot} start={start} day={params.day} />
}

function Printable({ doc, settings, snapshot, start, day }: { doc: MealsDoc; settings: MealSettings; snapshot: Snapshot; start: string; day: string | undefined }) {
  const locale = useLocale()
  const router = useRouter()
  const text = useMoneyText()
  const v = useMemo(() => weekView(snapshot, doc, settings, start), [snapshot, doc, settings, start])
  // 'week' is the week on one landscape page, 'days' a page a day, else one day.
  const which = day === 'days' || (day && v.days.some((d) => d.day === day)) ? day : 'week'
  const calendar = which === 'week'
  useStyle()
  usePageSize(calendar)
  const portal = usePortal()
  const [fit, setFit] = useState(FIT_MAX_PT)
  const [width, setWidth] = useState(0)
  const week = weekRange(start, locale)
  const money = (minor: number) => text(minor, settings.currency)
  const pages = calendar ? [] : v.days.filter((d) => which === 'days' || d.day === which).map((d) => ({ d, trip: v.trips.find((t) => t.day === d.day), week, money, people: settings.people, locale }))
  const cal: CalendarProps = { days: v.days, trips: v.trips, week, budget: v.budget ? text(v.budget.budget_minor, v.budget.currency) : null, money, locale }
  useEffect(() => {
    const page = portal?.querySelector<HTMLElement>('.wp-cal')
    if (page) setFit(fitSize(page))
  }, [portal, v, which, locale])
  const scale = width > 0 ? Math.min(1, width / (CAL_W_MM * MM_PX)) : 0
  const choices = [
    { value: 'week', title: 'The week on one page', detail: `${week} · landscape, with recipes and the shopping list` },
    { value: 'days', title: 'A page for each day', detail: 'With recipes, and the shopping as a to-do' },
    ...v.days.map((d) => ({ value: d.day, title: dayName(d.day, locale), detail: v.trips.some((t) => t.day === d.day) ? 'Shopping day' : undefined })),
  ]
  return (
    <View style={{ gap: SPACE[4] }}>
      <Choices label="Print" groups={[{ choices }]} value={which} onChange={(next) => router.setParams({ day: next === 'week' ? '' : next })} />
      <Button label="Print" icon="file-text" variant="primary" onPress={() => window.print()} />
      <Text variant="footnote" tone="text2">
        {calendar ? 'One landscape page: the week, its recipes and the shopping list. Lines and outlines only, to go easy on ink.' : 'One page a day. A shopping day starts with its trip as a to-do list.'}
      </Text>
      {calendar ? (
        <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          {scale > 0 ? h('div', { className: 'wp-doc wp-preview', style: { height: CAL_H_MM * MM_PX * scale, overflow: 'hidden' } }, h('div', { style: { transform: `scale(${scale})`, transformOrigin: 'top left', width: `${CAL_W_MM}mm` } }, h('div', { style: { fontSize: `${fit}pt` } }, h(CalendarPage, cal)))) : null}
        </View>
      ) : (
        <View>{h(Doc, { pages, preview: true })}</View>
      )}
      {portal ? createPortal(calendar ? h('div', { className: 'wp-doc' }, h(CalendarPage, cal)) : h(Doc, { pages, preview: false }), portal) : null}
    </View>
  )
}
