import { useRouter } from 'expo-router'
import { useMemo, type ReactNode } from 'react'
import { Pressable, useWindowDimensions, View, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { useSnapshot } from '@/data/hooks'
import { shortDay } from '@/data/status'
import { NEW_ACCOUNT_ID } from '@/shell/url.model'
import { AccountTile } from '@/ui/AccountTile'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Sparkline } from '@/ui/chart/Sparkline'
import { EmptyState } from '@/ui/EmptyState'
import { Icon } from '@/ui/icons'
import { Money, widestFigure } from '@/ui/Money'
import { Text } from '@/ui/Text'
import { TYPE, useFocusRing, useLocale, useTheme } from '@/ui/theme'
import { GUTTER, identityColor, LINE_WIDTH, ROW_MIN_HEIGHT, SPACE } from '@/ui/tokens'
import { moneyModel, nameRoom, sparkWidth, type AccountLine, type BaseTotal, type CurrencyGroup } from './money.model'

// Spec §7 Money: cash by currency with a total each, one approximate total in the base currency, then cards and loans, each opening its ledger.
export function MoneyTab() {
  const { snapshot } = useSnapshot()
  const router = useRouter()
  const model = useMemo(() => (snapshot ? moneyModel(snapshot) : null), [snapshot])
  const locale = useLocale()
  const windowWidth = useWindowDimensions().width
  if (!model) return null
  const lines = [...model.groups.flatMap((g) => g.accounts), ...model.debts]
  // One amount column for the whole screen, so every sparkline shares one x across currencies and debts.
  const width = widestFigure(lines.map((a) => ({ minor: a.kind === 'cash' ? a.live_minor : Math.abs(a.live_minor), currency: a.currency })), locale)
  const spark = sparkWidth(nameRoom(windowWidth, width), lines.map((a) => a.name), TYPE.headline.fontSize)
  const open = (id: string) => router.push({ pathname: '/money/[accountId]', params: { accountId: id } })
  if (model.groups.length === 0 && model.debts.length === 0) {
    return (
      <Card>
        <EmptyState title="No accounts yet" body="Each account you add shows here by currency, with its balance and its transactions." action={{ label: 'Add an account', onPress: () => router.push({ pathname: '/settings/account/[id]', params: { id: NEW_ACCOUNT_ID, kind: 'cash' } }) }} />
      </Card>
    )
  }
  return (
    <View style={{ gap: SPACE[6] }}>
      {model.groups.map((g) => (
        <Group key={g.currency} group={g} width={width} spark={spark} open={open} />
      ))}
      {model.base && model.base.kind !== 'single' ? <BaseLine base={model.base} /> : null}
      {model.debts.length > 0 ? (
        <View>
          <Heading title="Cards and loans" />
          <Card flush>
            {model.debts.map((a, i) => (
              <AccountRow key={a.account_id} a={a} divider={i > 0} width={width} spark={spark} onPress={() => open(a.account_id)} />
            ))}
          </Card>
        </View>
      ) : null}
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Import CSV" onPress={() => router.push('/import')} />
      </View>
    </View>
  )
}

// A section's heading in title2; a currency's group in headline, as Months and Plan head theirs.
function Heading({ title, currency = false, children }: { title: string; currency?: boolean; children?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: SPACE[3], marginBottom: SPACE[2] }}>
      <Text variant={currency ? 'headline' : 'title2'} level={2}>
        {title}
      </Text>
      {children}
    </View>
  )
}

function Group({ group, width, spark, open }: { group: CurrencyGroup; width: number; spark: number; open: (id: string) => void }) {
  return (
    <View>
      <Heading title={group.currency} currency>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: SPACE[2] }}>
          <Text variant="footnote" tone="text2">
            Total
          </Text>
          <Money minor={group.total_minor} currency={group.currency} variant="headline" />
        </View>
      </Heading>
      <Card flush>
        {group.accounts.map((a, i) => (
          <AccountRow key={a.account_id} a={a} divider={i > 0} width={width} spark={spark} onPress={() => open(a.account_id)} />
        ))}
      </Card>
    </View>
  )
}

// Fixed columns, so every row's sparkline and figure line up: the tile, the name, the sparkline, then the amount at the widest amount's width.
function AccountRow({ a, divider, width, spark, onPress }: { a: AccountLine; divider: boolean; width: number; spark: number; onPress: () => void }) {
  const { colors, scheme } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const hover = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { backgroundColor: colors.surface2 } : null)
  const debt = a.kind !== 'cash'
  // A debt reads as what is owed, positive (spec §8), its word under the figure so the figure keeps one width.
  const owed = debt ? -a.live_minor : a.live_minor
  return (
    <Pressable
      role="button"
      onPress={onPress}
      onFocus={onFocus}
      onBlur={onBlur}
      style={(s) => [{ minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[2], flexDirection: 'row', alignItems: 'center', gap: SPACE[3] }, hover(s), ring && { ...ring, outlineOffset: -2 }]}
    >
      {divider ? <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} /> : null}
      <AccountTile name={a.name} colour={a.colour} />
      <Text variant="headline" style={{ flex: 1, minWidth: 0 }}>
        {a.name}
      </Text>
      {spark > 0 ? <View style={{ width: spark, flexShrink: 0 }}>{a.spark.length > 1 ? <Sparkline values={a.spark} width={spark} height={24} colour={identityColor(a.colour, scheme)} /> : null}</View> : null}
      <View style={{ flexShrink: 0, minWidth: width, alignItems: 'flex-end' }}>
        <Money minor={debt ? Math.abs(owed) : owed} currency={a.currency} style={{ fontWeight: '600' }} />
        {debt && owed !== 0 ? (
          <Text variant="footnote" tone="text2">
            {owed < 0 ? 'in credit' : 'owed'}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron-right" size={18} color={colors.text3} />
    </Pressable>
  )
}

function BaseLine({ base }: { base: Exclude<BaseTotal, { kind: 'single' }> }) {
  const locale = useLocale()
  if (base.kind === 'missing') {
    return (
      <Card style={{ gap: SPACE[1] }}>
        <Text>{`No total in ${base.currency}`}</Text>
        <Text variant="footnote" tone="text2">
          {`There is no exchange rate for ${base.missing.length > 0 ? base.missing.join(' or ') : 'every currency'} yet, so the currencies cannot be added up.`}
        </Text>
      </Card>
    )
  }
  return (
    <Card style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: SPACE[4], rowGap: SPACE[2] }}>
      <View style={{ flexShrink: 1, gap: SPACE[1] }}>
        <Text>{`All cash in ${base.currency}, approx.`}</Text>
        <Text variant="footnote" tone="text2">
          {`At the rates of ${shortDay(base.day, locale)}`}
        </Text>
      </View>
      <Money minor={base.minor} currency={base.currency} variant="headline" />
    </Card>
  )
}
