import type { Snapshot } from '@waypoint/core'
import { addDays } from '@waypoint/core'
import { useRouter } from 'expo-router'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { ERROR_TITLES, type DataError } from '@/data/errors'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Money } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Text } from '@/ui/Text'
import { useLocale, useTheme } from '@/ui/theme'
import { GUTTER, LINE_WIDTH, SPACE } from '@/ui/tokens'
import { weekRange, type WeekView } from './meals.model'

export const STRONG = { fontWeight: '600' } as const

export function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: SPACE[3], marginBottom: SPACE[2] }}>
      <Text variant="title2" level={2}>
        {title}
      </Text>
      {children}
    </View>
  )
}

export const Divider = () => {
  const { colors } = useTheme()
  return <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} />
}

export function LoadFailed({ error, retry }: { error: DataError; retry: () => void }) {
  return <Banner tone="negative" title={ERROR_TITLES[error.kind]} body={error.message} detail={error.technical ?? undefined} action={{ label: 'Retry', onPress: retry }} />
}

// The week shown and the arrows to the weeks either side; the address keeps it, so Back and a reload return to the same week.
export function WeekStepper({ start, asOf, onWeek }: { start: string; asOf: string; onWeek: (start: string) => void }) {
  const locale = useLocale()
  const current = asOf >= start && asOf <= addDays(start, 6)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2] }}>
      <Button label="Week before" icon="chevron-left" variant="icon" iconOnly onPress={() => onWeek(addDays(start, -7))} />
      <View style={{ flex: 1, alignItems: 'center' }}>
        <Text variant="headline" numbers>
          {weekRange(start, locale)}
        </Text>
        <Text variant="footnote" tone="text2">
          {current ? 'This week' : start > asOf ? 'A week ahead' : 'A past week'}
        </Text>
      </View>
      <Button label="Week after" icon="chevron-right" variant="icon" iconOnly onPress={() => onWeek(addDays(start, 7))} />
    </View>
  )
}

// The week's shopping against the meals allowance, this month's position, and the other allowances on the list.
export function BudgetCard({ v, snapshot, currency, links = true }: { v: WeekView; snapshot: Snapshot; currency: string; links?: boolean }) {
  const router = useRouter()
  const name = (id: string | null) => snapshot.doc.categories.find((c) => c.id === id)?.name ?? 'No allowance'
  const b = v.budget
  const over = b !== null && b.over_minor > 0
  return (
    <Card style={{ gap: SPACE[3] }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: SPACE[2], rowGap: SPACE[1] }}>
        <Text variant="headline" style={{ flexShrink: 1 }}>
          {"This week's shopping"}
        </Text>
        <View style={{ marginLeft: 'auto', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: SPACE[1] }}>
          {b ? (
            <>
              <Money minor={b.cost_minor} currency={b.currency} variant="headline" style={{ fontWeight: '700' }} />
              <Text variant="footnote" tone="text2">
                {`${b.approx ? 'about, ' : ''}of\u00a0`}
                <Money minor={b.budget_minor} currency={b.currency} variant="footnote" tone="text2" />
                {'\u00a0for the week'}
              </Text>
            </>
          ) : null}
        </View>
      </View>
      {over ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE[2] }}>
          <Pill tone="caution" icon="triangle-alert">
            Over the week
          </Pill>
          <Text variant="footnote" tone="text2">
            <Money minor={b.over_minor} currency={b.currency} variant="footnote" style={STRONG} />
            {'\u00a0more than this week’s share of the allowance'}
          </Text>
        </View>
      ) : null}
      {!b ? (
        <Text variant="footnote" tone="text2">
          No allowance covers this week. Pick the one meals count against under Settings below, or add one in Plan.
        </Text>
      ) : null}
      {v.missing > 0 ? <Text variant="footnote" tone="text2">{`${v.missing} ${v.missing === 1 ? 'line has' : 'lines have'} no price, so the total is low. Add prices in the price list.`}</Text> : null}
      {v.month ? (
        <Text variant="footnote" tone="text2">
          {'This month:\u00a0'}
          <Money minor={v.month.spent_minor} currency={v.month.currency} variant="footnote" style={STRONG} />
          {'\u00a0spent and\u00a0'}
          <Money minor={v.month.planned_minor} currency={v.month.currency} variant="footnote" style={STRONG} />
          {'\u00a0still to buy, of\u00a0'}
          <Money minor={v.month.budget_minor} currency={v.month.currency} variant="footnote" />
          {v.month.left_minor >= 0 ? ' · ' : ' · over by\u00a0'}
          <Money minor={Math.abs(v.month.left_minor)} currency={v.month.currency} variant="footnote" style={STRONG} />
          {v.month.left_minor >= 0 ? '\u00a0left' : ''}
        </Text>
      ) : null}
      {v.others.length > 0 ? (
        <Text variant="footnote" tone="text2">
          {'Also on the list: '}
          {v.others.map((o, i) => (
            <Text key={o.category_id ?? 'none'} variant="footnote" tone="text2">
              {i > 0 ? ', ' : ''}
              {`${name(o.category_id)}\u00a0`}
              <Money minor={o.cost_minor} currency={currency} variant="footnote" tone="text2" />
            </Text>
          ))}
        </Text>
      ) : null}
      {links ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
          <Button label="Shopping list" icon="file-text" variant="primary" size="small" onPress={() => router.push(`/meals/shop?week=${v.start}`)} />
          <Button label="Print the week" variant="secondary" size="small" onPress={() => router.push(`/meals/print?week=${v.start}`)} />
        </View>
      ) : null}
    </Card>
  )
}
