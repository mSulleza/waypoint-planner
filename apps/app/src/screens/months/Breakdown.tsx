import type { Snapshot, Walk } from '@waypoint/core'
import { useRouter } from 'expo-router'
import { useMemo } from 'react'
import { View } from 'react-native'
import { shortDay } from '@/data/status'
import { monthTitle } from '@/shell/url.model'
import { Card } from '@/ui/Card'
import { CopyText, useCopyWords } from '@/ui/CopyText'
import { EmptyState } from '@/ui/EmptyState'
import { Money } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Text } from '@/ui/Text'
import { useLocale, useTheme } from '@/ui/theme'
import { GUTTER, LINE_WIDTH, ROW_MIN_HEIGHT, SPACE } from '@/ui/tokens'
import { PLAN_EDITOR } from '../today/today.model'
import { breakdownOf, type BreakdownLine, type CurrencyBreakdown, type KindGroup } from './breakdown.model'

export interface BreakdownProps {
  snapshot: Snapshot
  walk: Walk
  month: string
}

const SPENDING_FAST = 'Spending fast'

const Divider = () => {
  const { colors } = useTheme()
  return <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} />
}

// Spec §7 Months > Breakdown: per currency, money in and out, then each kind's lines with their flags as words.
export function Breakdown({ snapshot, walk, month }: BreakdownProps) {
  const locale = useLocale()
  const router = useRouter()
  const b = useMemo(() => breakdownOf(snapshot, walk, month), [snapshot, walk, month])
  if (b.currencies.length === 0) {
    return (
      <Card>
        <EmptyState
          title={`No money moves in ${monthTitle(b.month, locale)}`}
          body={b.kind === 'past' ? 'Transactions you enter show here by kind, with what came in and went out.' : 'Income, bills, transfers and budgets from your plan show here by kind, with what comes in and goes out.'}
          // A past month fills from what was entered; a later one from the plan.
          action={b.kind === 'past' ? { label: 'Add a transaction', onPress: () => router.push({ pathname: '/add', params: { mode: 'out' } }) } : { label: 'Add an item', onPress: () => router.push(PLAN_EDITOR) }}
        />
      </Card>
    )
  }
  const range = `${shortDay(b.from, locale)} → ${shortDay(b.to, locale)}`
  return (
    <View style={{ gap: SPACE[5] }}>
      {b.currencies.map((c) => (
        <Currency key={c.currency} c={c} range={range} />
      ))}
    </View>
  )
}

// One card per currency: what came in and went out, then each kind under its own heading row with its totals.
function Currency({ c, range }: { c: CurrencyBreakdown; range: string }) {
  return (
    <View style={{ gap: SPACE[2] }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: SPACE[3] }}>
        <Text variant="headline" level={3}>
          {c.currency}
        </Text>
        <Text variant="footnote" tone="text2">
          {range}
        </Text>
      </View>
      <Card flush>
        <Total label="Money in" minor={c.in_minor} currency={c.currency} />
        <Total label="Money out" minor={-c.out_minor} currency={c.currency} divider />
        {c.groups.map((g) => (
          <Group key={g.kind} g={g} currency={c.currency} />
        ))}
      </Card>
    </View>
  )
}

function Total({ label, minor, currency, divider = false }: { label: string; minor: number; currency: string; divider?: boolean }) {
  return (
    <View style={{ minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[3], flexDirection: 'row', alignItems: 'center', columnGap: SPACE[3] }}>
      {divider ? <Divider /> : null}
      <Text variant="headline" style={{ flex: 1, minWidth: 0 }}>
        {label}
      </Text>
      <View style={{ flexShrink: 0 }}>
        <Money minor={minor} currency={currency} signed variant="headline" />
      </View>
    </View>
  )
}

function Group({ g, currency }: { g: KindGroup; currency: string }) {
  const { colors } = useTheme()
  // A kind that only moves one way shows that total; transfers show both, and moves alone none.
  const sums = [g.in_minor > 0 ? g.in_minor : null, g.out_minor > 0 ? -g.out_minor : null].filter((x): x is number => x !== null)
  return (
    <View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: SPACE[3], paddingHorizontal: GUTTER, paddingTop: SPACE[4], paddingBottom: SPACE[1] }}>
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} />
        <Text variant="footnote" tone="text2" level={4} style={{ fontWeight: '600' }}>
          {g.title}
        </Text>
        <View style={{ flexDirection: 'row', gap: SPACE[3] }}>
          {sums.map((s) => (
            <Money key={s > 0 ? 'in' : 'out'} minor={s} currency={currency} signed variant="footnote" tone="text2" style={{ fontWeight: '600' }} />
          ))}
        </View>
      </View>
      {g.lines.map((l, i) => (
        <Line key={l.id} l={l} currency={currency} divider={i > 0} />
      ))}
    </View>
  )
}

function Line({ l, currency, divider }: { l: BreakdownLine; currency: string; divider: boolean }) {
  const words = useCopyWords()
  const account = words({ account: l.account_id })
  const other = l.other_account_id ? words({ account: l.other_account_id }) : null
  const where = other === null ? account : l.move ? `${account} → ${other}` : `${account}, ${l.amount_minor < 0 ? 'to' : 'from'} ${other}`
  const when = l.until !== l.date ? `${words({ date: l.date })} → ${words({ date: l.until })}` : words({ date: l.date })
  // Spending fast is a status, so it takes its caution pill as on Today; the other words are facts and stay in the line.
  const fast = l.words.includes(SPENDING_FAST)
  const detail = [`${when} · ${where}`, ...l.words.filter((w) => w !== SPENDING_FAST)].join(' · ')
  const budget = l.budget
  return (
    <View style={{ minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[3], flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3] }}>
      {divider ? <Divider /> : null}
      <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
        <CopyText copy={l.title} variant="headline" />
        <Text variant="footnote" tone="text2">
          {detail}
        </Text>
        {budget ? (
          <Text variant="footnote" tone="text2">
            <Money minor={budget.budget_minor} currency={budget.currency} variant="footnote" tone="text2" />
            {' budget · '}
            <Money minor={budget.spent_minor} currency={budget.currency} variant="footnote" tone="text2" />
            {' spent'}
          </Text>
        ) : null}
        {fast ? <Pill tone="caution">{SPENDING_FAST}</Pill> : null}
      </View>
      <View style={{ flexShrink: 0, maxWidth: '50%', alignItems: 'flex-end' }}>
        {/* A move is neither in nor out, so it has no sign. */}
        <Money minor={l.amount_minor} currency={currency} signed={!l.move} style={{ fontWeight: '600' }} />
      </View>
    </View>
  )
}
