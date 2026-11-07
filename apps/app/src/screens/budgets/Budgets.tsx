import type { BudgetRow } from '@waypoint/core'
import { useRouter } from 'expo-router'
import { useMemo, type ReactNode } from 'react'
import { View } from 'react-native'
import { useSnapshot } from '@/data/hooks'
import { shortDay } from '@/data/status'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { useCopyWords } from '@/ui/CopyText'
import { EmptyState } from '@/ui/EmptyState'
import { Icon } from '@/ui/icons'
import { Money, useSpokenMoney } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Text } from '@/ui/Text'
import { useLocale, useTheme } from '@/ui/theme'
import { GUTTER, LINE_WIDTH, RADII, ROW_MIN_HEIGHT, SPACE } from '@/ui/tokens'
import { WeekColumns, type WeekColumn } from '@/ui/WeekColumns'
import { budgetsModel, monthName, patternWords, type StripWeek, type WeekLine } from './budgets.model'

const STRONG = { fontWeight: '600' } as const

// Spec §7 Budgets: this week's weekly budgets together, then each one with its plan mark and the month's weeks, then the budgets read by the month.
export function BudgetsBody() {
  const { snapshot } = useSnapshot()
  const router = useRouter()
  const locale = useLocale()
  const m = useMemo(() => (snapshot ? budgetsModel(snapshot) : null), [snapshot])
  if (!m) return null
  if (m.weekly.length === 0 && m.monthly.length === 0) {
    return <EmptyState title="No budgets this month" body="Budgets you add in Plan show here week by week, against the days you usually spend." action={{ label: 'Open Plan', onPress: () => router.push('/plan') }} />
  }
  const month = monthName(m.month, locale)
  const range = m.from === m.to ? shortDay(m.from, locale) : `${shortDay(m.from, locale)} – ${shortDay(m.to, locale)}`
  return (
    <View style={{ gap: SPACE[4] }}>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Plan meals and shopping" variant="secondary" size="small" onPress={() => router.push('/meals')} />
      </View>
      {m.weekly.length > 0 ? (
        <View>
          <Heading title="This week">
            <Text variant="footnote" tone="text2" numbers>
              {`${range} · Day ${m.day} of ${m.days}`}
            </Text>
          </Heading>
          <View style={{ gap: SPACE[4] }}>
            {m.total && m.weekly.length > 1 ? (
              <Card flush>
                <WeekPart l={m.total} title="Weekly budgets together" month={month} />
              </Card>
            ) : null}
            <Card flush>
              {m.weekly.map((l, i) => (
                <WeekPart key={l.category_id} l={l} month={month} divider={i > 0} />
              ))}
            </Card>
          </View>
        </View>
      ) : null}
      {m.monthly.length > 0 ? (
        <View>
          <Heading title="By the month">
            <Text variant="footnote" tone="text2">
              Spent in lumps, not every week
            </Text>
          </Heading>
          <Card flush>
            {m.monthly.map((b, i) => (
              <MonthPart key={b.category_id} b={b} divider={i > 0} />
            ))}
          </Card>
        </View>
      ) : null}
    </View>
  )
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: SPACE[3], marginBottom: SPACE[2] }}>
      <Text variant="title2" level={2}>
        {title}
      </Text>
      {children}
    </View>
  )
}

const Divider = () => {
  const { colors } = useTheme()
  return <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} />
}

// A pace word as Today draws it: Spending fast in a caution pill, On pace quietly with a gauge.
function Word({ word }: { word: BudgetRow['word'] }) {
  const { colors } = useTheme()
  if (word === 'Spending fast') return <Pill tone="caution">{word}</Pill>
  if (!word) return null
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[1] }}>
      <Icon name="gauge" size={14} color={colors.text2} strokeWidth={2.4} />
      <Text variant="footnote" tone="text2" style={STRONG}>
        {word}
      </Text>
    </View>
  )
}

// One week: what is left of it, its word and pattern, the bar against the pattern's plan by today, the rates, then the month's weeks.
function WeekPart({ l, title, month, divider = false }: { l: WeekLine; title?: string; month: string; divider?: boolean }) {
  const { colors } = useTheme()
  const words = useCopyWords()
  const locale = useLocale()
  const spoken = useSpokenMoney()
  const over = l.left_minor < 0
  const name = title ?? (l.category_id ? words({ category: l.category_id }) : '')
  return (
    <View style={{ minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingTop: SPACE[3], paddingBottom: SPACE[4] }}>
      {divider ? <Divider /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: SPACE[2], rowGap: SPACE[1] }}>
        <Text variant="headline" style={{ flexShrink: 1 }}>
          {name}
        </Text>
        <View style={{ marginLeft: 'auto', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'flex-end', columnGap: SPACE[1] }}>
          <Money minor={over ? -l.left_minor : l.left_minor} currency={l.currency} variant="headline" style={{ fontWeight: '700' }} />
          <Text variant="footnote" tone="text2">
            {over ? 'over a\u00a0' : 'left of\u00a0'}
            <Money minor={l.budget_minor} currency={l.currency} variant="footnote" tone="text2" />
            {over ? '\u00a0week' : '\u00a0this week'}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[2], rowGap: SPACE[1], marginTop: SPACE[2] }}>
        <Word word={l.word} />
        {l.category_id ? (
          <Text variant="footnote" tone="text3" style={{ marginLeft: 'auto' }}>
            {patternWords(l, locale)}
          </Text>
        ) : null}
      </View>
      <View role="img" aria-label={`Spent ${spoken(l.spent_minor, l.currency)} of ${spoken(l.budget_minor, l.currency)} this week. The plan by today is ${spoken(l.plan_by_today_minor, l.currency)}.`} style={{ height: BAR_HEIGHT, marginTop: SPACE[3], borderRadius: RADII.pill, backgroundColor: colors.surface2 }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${l.bar.spent * 100}%`, borderRadius: RADII.pill, backgroundColor: colors[l.bar.fill] }} />
        {/* The plan's mark stands proud of the bar, ringed in the card's colour so it reads over the fill. */}
        <View style={{ position: 'absolute', left: `${l.bar.mark * 100}%`, top: -(MARK_REACH + MARK_RING), width: MARK_WIDTH + 2 * MARK_RING, height: BAR_HEIGHT + 2 * (MARK_REACH + MARK_RING), transform: [{ translateX: -(MARK_WIDTH / 2 + MARK_RING) }], borderRadius: RADII.pill, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: MARK_WIDTH, height: BAR_HEIGHT + 2 * MARK_REACH, borderRadius: MARK_RING, backgroundColor: colors.text }} />
        </View>
      </View>
      <View style={{ marginTop: SPACE[3] }}>
        <Text variant="footnote" tone="text2">
          {/* No-break spaces keep each amount with its words when the line wraps. */}
          <Money minor={l.spent_minor} currency={l.currency} variant="footnote" style={STRONG} />
          {'\u00a0spent, plan by today\u00a0'}
          <Money minor={l.plan_by_today_minor} currency={l.currency} variant="footnote" style={STRONG} />
          {l.usual_day_minor !== null ? (
            <>
              {' · usually\u00a0'}
              <Money minor={l.usual_day_minor} currency={l.currency} variant="footnote" tone="text2" />
              {'\u00a0a time'}
            </>
          ) : null}
        </Text>
        <Text variant="footnote" tone="text2">
          {l.per_week_minor > 0 ? (
            <>
              <Money minor={l.per_week_minor} currency={l.currency} variant="footnote" tone="text2" />
              {`\u00a0a week from here keeps ${month} on budget`}
            </>
          ) : (
            `Nothing left of ${month}'s budget`
          )}
        </Text>
      </View>
      <Weeks weeks={l.weeks} currency={l.currency} />
    </View>
  )
}

// The month's weeks: spent in each against its own budget, and a week to come's budget.
function Weeks({ weeks, currency }: { weeks: readonly StripWeek[]; currency: string }) {
  const locale = useLocale()
  const spoken = useSpokenMoney()
  const columns = weeks.map((w): WeekColumn => {
    const days = `${shortDay(w.from, locale)} to ${shortDay(w.to, locale)}`
    const said = w.state === 'future' ? `${days}: ${spoken(w.budget_minor, currency)} to spend` : `${days}${w.state === 'current' ? ', this week' : ''}: spent ${spoken(w.spent_minor, currency)} of ${spoken(w.budget_minor, currency)}${w.over ? ', over its budget' : ''}`
    return { key: w.from, label: `${Number(w.from.slice(8))}–${Number(w.to.slice(8))}`, amount_minor: w.state === 'future' ? w.budget_minor : w.spent_minor, currency, share: w.share, over: w.over, current: w.state === 'current', future: w.state === 'future', spoken: said }
  })
  return (
    <View style={{ marginTop: SPACE[4] }}>
      <WeekColumns columns={columns} />
    </View>
  )
}

// A budget read by the month, as Today's pace rows word it.
function MonthPart({ b, divider }: { b: BudgetRow; divider: boolean }) {
  const words = useCopyWords()
  const over = b.left_minor < 0
  return (
    <View style={{ minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[3] }}>
      {divider ? <Divider /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: SPACE[2], rowGap: SPACE[1] }}>
        <Text variant="headline" style={{ flexShrink: 1 }}>
          {words({ category: b.category_id })}
        </Text>
        <View style={{ marginLeft: 'auto', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'flex-end', columnGap: SPACE[1] }}>
          <Money minor={over ? -b.left_minor : b.left_minor} currency={b.currency} variant="headline" style={{ fontWeight: '700' }} />
          <Text variant="footnote" tone="text2">
            {over ? 'over a\u00a0' : 'left of\u00a0'}
            <Money minor={b.budget_minor} currency={b.currency} variant="footnote" tone="text2" />
            {over ? '\u00a0budget' : ''}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[2], rowGap: SPACE[1], marginTop: SPACE[2] }}>
        <Word word={b.word} />
        <Text variant="footnote" tone="text3" numbers style={{ marginLeft: 'auto' }}>
          {`Day ${b.days_elapsed} of ${b.days_in_month}`}
        </Text>
      </View>
    </View>
  )
}

// The bar and its mark match Today's pace rows.
const BAR_HEIGHT = 10
const MARK_WIDTH = 3
const MARK_REACH = 4
const MARK_RING = 2
