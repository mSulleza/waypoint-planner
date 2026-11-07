import type { Copy, Snapshot, Walk } from '@waypoint/core'
import { useRouter } from 'expo-router'
import { memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import { Pressable, View, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { useBreakeven, useEngineSoon, useSnapshot } from '@/data/hooks'
import { shortDay } from '@/data/status'
import { Screen } from '@/shell/Screen'
import { monthTitle } from '@/shell/url.model'
import { AccountTile } from '@/ui/AccountTile'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Chip } from '@/ui/Chip'
import { CopyText, useCopyWords } from '@/ui/CopyText'
import { EmptyState } from '@/ui/EmptyState'
import { Hero, HeroEyebrow, HeroFigure } from '@/ui/Hero'
import { Icon } from '@/ui/icons'
import { FxRate, Money } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Text } from '@/ui/Text'
import { TYPE, useFocusRing, useLocale, useTheme } from '@/ui/theme'
import { useIdentity } from '@/ui/useIdentity'
import { GUTTER, iconNudge, LINE_WIDTH, RADII, ROW_MIN_HEIGHT, SPACE, WORD_TONE } from '@/ui/tokens'
import { useMoneyLasts } from './money-lasts'
import {
  BASIS,
  COMPARE,
  fxView,
  GROUP_NOTES,
  groupHeading,
  itemRows,
  lastsView,
  NEW_ITEM,
  planHeadline,
  planList,
  scheduleWords,
  type CashLine,
  type FxView,
  type ItemGroup,
  type ItemRow,
  type LastsView,
  type PlanHeadline,
  type PlanLink,
  type PlanListItem,
} from './plan.model'

// No-break spaces keep each amount with its words when a line wraps.
const NB = ' '

const dayText = (day: string, locale: string, asOf: string) => shortDay(day, locale, day.slice(0, 4) !== asOf.slice(0, 4)).replace(/ /g, NB)

const percent = (value: number, locale: string) => new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)

const days = (n: number) => `${n}${NB}day${n === 1 ? '' : 's'}`

const errorsOf = (errors: readonly (string | { message: string })[]) => errors.map((e) => (typeof e === 'string' ? e : e.message)).join(' ')

function useGo(): (link: PlanLink) => void {
  const router = useRouter()
  return useCallback((link) => router.push(link), [router])
}

// Spec §7 Plan: the headline numbers from the engine, then every plan item by kind; the items are a virtualised list under the headline.
export function PlanTab() {
  const run = useEngineSoon()
  const { refetch } = useSnapshot()
  if (!run) {
    return (
      <Screen title="Plan" kind="tab">
        <Text tone="text2">Working out the plan…</Text>
      </Screen>
    )
  }
  if (!run.ok) {
    return (
      <Screen title="Plan" kind="tab">
        <Banner tone="negative" title="Could not work out the projection" body={errorsOf(run.errors)} action={{ label: 'Retry', icon: 'rotate-cw', onPress: refetch }} />
      </Screen>
    )
  }
  return <PlanBody snapshot={run.world.snapshot} walk={run.walk} />
}

// Whether Past is open, kept for this session only: a new session starts with it closed.
let pastOpenNow = false

function usePastOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(pastOpenNow)
  const toggle = useCallback(() => {
    pastOpenNow = !pastOpenNow
    setOpen(pastOpenNow)
  }, [])
  return [open, toggle]
}

function PlanBody({ snapshot, walk }: { snapshot: Snapshot; walk: Walk }) {
  const go = useGo()
  const locale = useLocale()
  const [pastOpen, togglePast] = usePastOpen()
  const head = useMemo(() => planHeadline(snapshot, walk), [snapshot, walk])
  const rows = useMemo(() => itemRows(snapshot, walk), [snapshot, walk])
  const list = useMemo(() => planList(rows, locale, pastOpen), [rows, locale, pastOpen])
  // Stable, so the list's cells redraw only when their own row changes.
  const render = useCallback((item: PlanListItem) => <PlanCell item={item} asOf={snapshot.as_of} go={go} togglePast={togglePast} />, [snapshot.as_of, go, togglePast])
  return (
    <Screen title="Plan" kind="tab" list={{ data: list, keyOf: (item) => item.key, render }}>
      <View style={{ gap: SPACE[6] }}>
        <Lead head={head} asOf={snapshot.as_of} />
        <Accounts groups={head.cash} asOf={snapshot.as_of} />
        <View style={{ gap: SPACE[3] }}>
          <Outlook snapshot={snapshot} horizonMonth={head.horizon_month} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[4], rowGap: SPACE[2] }}>
            <Button label="Compare" onPress={() => go(COMPARE)} />
            <Text variant="footnote" tone="text2" style={{ flexShrink: 1 }}>
              Try a change beside this plan.
            </Text>
          </View>
        </View>
        <View style={{ gap: SPACE[3] }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: SPACE[3], rowGap: SPACE[1] }}>
            <Text variant="title2" level={2}>
              Plan items
            </Text>
            {/* An empty plan offers its one button in the empty state below. */}
            {list.length > 0 ? (
              <View style={{ marginRight: -GUTTER }}>
                <Button label="Add an item" icon="plus" variant="plain" onPress={() => go(NEW_ITEM)} />
              </View>
            ) : null}
          </View>
          {list.length === 0 ? (
            <Card>
              <EmptyState title="No plan items yet" body="Add your income and bills, and the plan works out the months ahead from them." action={{ label: 'Add an item', onPress: () => go(NEW_ITEM) }} />
            </Card>
          ) : null}
        </View>
      </View>
    </Screen>
  )
}

const Rule = () => {
  const { colors } = useTheme()
  return <View style={{ height: LINE_WIDTH, backgroundColor: colors.line }} />
}

// The debt-free month as the screen's one Cobalt hero, read as one heading, with what the figures stand on; Try extra payments sits under it, as on Debts.
function Lead({ head, asOf }: { head: PlanHeadline; asOf: string }) {
  const words = useCopyWords()
  const locale = useLocale()
  const router = useRouter()
  const extra = head.try_extra
  const { label, value, note } = head.debt_free
  const said = `${label} ${value.map((p) => ('money' in p ? '' : words(p))).join('')}`
  return (
    <View style={{ gap: SPACE[3] }}>
      <Hero>
        <View role="heading" aria-level={2} aria-label={said}>
          <HeroEyebrow aria-hidden>{label}</HeroEyebrow>
          <HeroFigure copy={value} />
        </View>
        <View style={{ marginTop: SPACE[1], gap: SPACE[1] }}>
          {note ? <CopyText copy={note} variant="subhead" tone="onBrand2" /> : null}
          <Text variant="footnote" tone="onBrand2">
            {`${BASIS(dayText(asOf, locale, asOf))}, to the end of ${monthTitle(head.horizon_month, locale)}.`}
          </Text>
        </View>
      </Hero>
      {extra ? (
        <View style={{ alignItems: 'flex-start' }}>
          <Button label="Try extra payments" onPress={() => router.push(extra)} />
        </View>
      ) : null}
    </View>
  )
}

function Accounts({ groups, asOf }: { groups: PlanHeadline['cash']; asOf: string }) {
  if (groups.length === 0) return null
  return (
    <View style={{ gap: SPACE[3] }}>
      <Text variant="title2" level={2}>
        Lowest balances
      </Text>
      {groups.map((g) => (
        <View key={g.currency} style={{ gap: SPACE[2] }}>
          <Text variant="headline" level={3}>
            {g.currency}
          </Text>
          <Card flush>
            {g.accounts.map((a, i) => (
              <AccountLine key={a.account_id} a={a} asOf={asOf} divider={i > 0} />
            ))}
          </Card>
        </View>
      ))}
    </View>
  )
}

// One cash account: its word on Months' scale, its lowest balance to the end of the projection and the day it falls, its floor, and the days under it.
function AccountLine({ a, asOf, divider }: { a: CashLine; asOf: string; divider: boolean }) {
  const { colors } = useTheme()
  const words = useCopyWords()
  const colourOf = useIdentity()
  const name = words({ account: a.account_id })
  const locale = useLocale()
  // With no floor set, the floor is zero, so its days under the floor are days below zero.
  const meta = a.days_under_floor > 0 ? `${days(a.days_under_floor)} ${a.floor ? 'under the floor' : 'below zero'}` : a.days_under_target > 0 ? `${days(a.days_under_target)} under the target` : a.floor ? 'No days under the floor' : null
  return (
    <View style={{ minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[3], flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3] }}>
      {divider ? <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} /> : null}
      <AccountTile name={name} colour={colourOf(a.account_id)} />
      <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', columnGap: SPACE[3] }}>
          <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
            <Text variant="headline" style={{ flexShrink: 1 }}>
              {name}
            </Text>
            {meta ? (
              <Text variant="footnote" tone="text2">
                {meta}
              </Text>
            ) : null}
          </View>
          <View style={{ flexShrink: 0, alignItems: 'flex-end', gap: SPACE[1] }}>
            <Money minor={a.lowest_minor} currency={a.currency} style={{ fontWeight: '700' }} />
            <Text variant="footnote" tone="text2">{`Lowest on ${dayText(a.lowest_on, locale, asOf)}`}</Text>
          </View>
        </View>
        {/* The word sits where Today puts it: a pill at the far end of the line under the figures. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[2], rowGap: SPACE[1] }}>
          {a.floor ? <CopyText copy={[{ text: 'Floor ' }, ...a.floor]} variant="footnote" tone="text2" style={{ flexShrink: 1 }} /> : <Text variant="footnote" tone="text2">No floor set</Text>}
          <View style={{ marginLeft: 'auto' }}>
            <Pill tone={WORD_TONE[a.word]}>{a.word}</Pill>
          </View>
        </View>
      </View>
    </View>
  )
}

// A label and its note on the left, the figure at the far edge, wrapping under the label when the line is short.
function Fact({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: SPACE[1] }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: SPACE[4], rowGap: SPACE[1] }}>
        <Text style={{ flexShrink: 1, flexGrow: 1, flexBasis: 160 }}>{label}</Text>
        <View style={{ marginLeft: 'auto', alignItems: 'flex-end' }}>{children}</View>
      </View>
      {note}
    </View>
  )
}

const Calculating = () => (
  <Text variant="headline" tone="text2">
    Calculating…
  </Text>
)

const Note = ({ children }: { children: ReactNode }) => (
  <Text variant="footnote" tone="text2">
    {children}
  </Text>
)

// FX margin and breakeven rate in a two-currency household, then months the money lasts if income stops; both are worked out between frames.
function Outlook({ snapshot, horizonMonth }: { snapshot: Snapshot; horizonMonth: string }) {
  const breakeven = useBreakeven()
  const lasts = useMoneyLasts(snapshot)
  const fx = useMemo(() => fxView(breakeven.ready ? breakeven.value : undefined), [breakeven])
  const money = useMemo(() => lastsView(lasts, snapshot.as_of, horizonMonth), [lasts, snapshot.as_of, horizonMonth])
  return (
    <View style={{ gap: SPACE[3] }}>
      <Text variant="title2" level={2}>
        If things change
      </Text>
      <Card style={{ gap: SPACE[4] }}>
        {fx.state === 'none' ? null : (
          <>
            <FxFacts fx={fx} asOf={snapshot.as_of} />
            <Rule />
          </>
        )}
        <LastsFact v={money} asOf={snapshot.as_of} />
      </Card>
    </View>
  )
}

function FxFacts({ fx, asOf }: { fx: Exclude<FxView, { state: 'none' }>; asOf: string }) {
  const locale = useLocale()
  const words = useCopyWords()
  if (fx.state === 'calculating') {
    return (
      <>
        <Fact label="FX margin">
          <Calculating />
        </Fact>
        <Fact label="Breakeven rate">
          <Calculating />
        </Fact>
      </>
    )
  }
  if (fx.state === 'failed') {
    return (
      <Fact label="FX margin" note={<Note>{fx.message}</Note>}>
        <Text variant="headline" tone="text2">
          Not worked out
        </Text>
      </Fact>
    )
  }
  const funding = fx.funding_currency
  const marginNote = fx.below_range
    ? `${funding} can fall by half from today’s rate and still no cash account ends a day below zero.`
    : fx.margin > 0
      ? `How far ${funding} can fall from today’s rate before a cash account ends a day below zero.`
      : fx.margin < 0
        ? `${funding} has to rise ${percent(-fx.margin, locale)} from today’s rate before every cash account stays at or above zero.`
        : `At any rate below today’s, a cash account ends a day below zero.`
  return (
    <>
      <Fact label="FX margin" note={<Note>{marginNote}</Note>}>
        <Text variant="headline" numbers>
          {fx.below_range ? `${percent(0.5, locale)} or more` : percent(fx.margin, locale)}
        </Text>
      </Fact>
      {fx.pairs.map((p) => (
        <Fact
          key={`${p.from}-${p.to}`}
          label="Breakeven rate"
          note={
            <Note>
              {`Today${NB}`}
              <FxRate from={p.from} to={p.to} unitMinor={p.unit_minor} quoteMinor={p.today_minor} />
              {fx.below_range ? '. Even at half today’s rate, no account goes below zero.' : fx.binding ? `. If ${funding} is any weaker, ${words({ account: fx.binding.account_id })} goes below zero first, on ${dayText(fx.binding.date, locale, asOf)}.` : '.'}
            </Note>
          }
        >
          {fx.below_range ? (
            // The search stops at half today's rate, so the breakeven is somewhere below it, not at it.
            <Text variant="headline">
              {`Below${NB}`}
              <FxRate from={p.from} to={p.to} unitMinor={p.unit_minor} quoteMinor={p.breakeven_minor} variant="headline" tone="text" />
            </Text>
          ) : (
            <FxRate from={p.from} to={p.to} unitMinor={p.unit_minor} quoteMinor={p.breakeven_minor} variant="headline" tone="text" />
          )}
        </Fact>
      ))}
      {fx.rate_independent.length > 0 ? (
        <View style={{ gap: SPACE[1] }}>
          <Pill tone="negative">Below zero at any rate</Pill>
          {fx.rate_independent.map((r) => (
            <Text key={r.account_id} variant="footnote">{`${words({ account: r.account_id })}: ${days(r.days)} from ${dayText(r.date, locale, asOf)}`}</Text>
          ))}
          <Note>No rate fixes these days, so the margin leaves them out.</Note>
        </View>
      ) : null}
    </>
  )
}

const LASTS_LABEL = 'Months the money lasts if income stops'

function LastsFact({ v, asOf }: { v: LastsView; asOf: string }) {
  const locale = useLocale()
  const words = useCopyWords()
  if (v.state === 'calculating') {
    return (
      <Fact label={LASTS_LABEL}>
        <Calculating />
      </Fact>
    )
  }
  if (v.state === 'failed') {
    return (
      <Fact label={LASTS_LABEL} note={<Note>{v.message}</Note>}>
        <Text variant="headline" tone="text2">
          Not worked out
        </Text>
      </Fact>
    )
  }
  const from = monthTitle(v.from_month, locale)
  const note =
    v.state === 'through'
      ? `With no income from ${from} and every floor spent, no cash account ends a day below zero before the projection ends in ${monthTitle(v.horizon_month, locale)}.`
      : v.date < `${v.from_month}-01`
        ? `${words({ account: v.account_id })} ends a day below zero on ${dayText(v.date, locale, asOf)}, before income would stop in ${from}.`
        : `With no income from ${from} and every floor spent, ${words({ account: v.account_id })} first ends a day below zero on ${dayText(v.date, locale, asOf)}.`
  return (
    <Fact label={LASTS_LABEL} note={<Note>{note}</Note>}>
      <Text variant="headline" numbers>
        {v.state === 'through' ? `${v.months} or more` : String(v.months)}
      </Text>
    </Fact>
  )
}

interface CellProps {
  item: PlanListItem
  asOf: string
  go: (link: PlanLink) => void
  togglePast: () => void
}

// One list item: a group heading, Past's toggle or a plan item. Memoised, as the list redraws every cell whenever the screen redraws.
const PlanCell = memo(function PlanCell({ item, asOf, go, togglePast }: CellProps) {
  if (item.type === 'group') return <GroupHeading group={item.group} count={item.count} />
  if (item.type === 'past') return <PastHeading count={item.count} open={item.open} toggle={togglePast} />
  return <ItemLine row={item.row} asOf={asOf} first={item.first} last={item.last} go={go} />
})

const GroupNote = ({ group }: { group: ItemGroup }) => {
  const note = GROUP_NOTES[group]
  return note ? (
    <Text variant="footnote" tone="text2">
      {note}
    </Text>
  ) : null
}

function GroupHeading({ group, count }: { group: ItemGroup; count: number }) {
  return (
    <View style={{ paddingTop: SPACE[5], paddingBottom: SPACE[2], gap: SPACE[1] }}>
      <Text variant="footnote" tone="text2" level={3} style={{ fontWeight: '600' }}>
        {groupHeading(group, count)}
      </Text>
      <GroupNote group={group} />
    </View>
  )
}

// Past is one row that opens in place, so the list leads with what is still to come.
function PastHeading({ count, open, toggle }: { count: number; open: boolean; toggle: () => void }) {
  return (
    <View style={{ paddingTop: SPACE[3], paddingBottom: open ? SPACE[2] : 0, gap: SPACE[1] }}>
      <View role="heading" aria-level={3} style={{ flexDirection: 'row', marginLeft: -GUTTER }}>
        <Button label={groupHeading('past', count)} icon={open ? 'chevron-up' : 'chevron-down'} variant="plain" onPress={toggle} expanded={open} />
      </View>
      <GroupNote group="past" />
    </View>
  )
}

interface ItemLineProps {
  row: ItemRow
  asOf: string
  // The group's first and last rows round the card's corners, so each group reads as one card.
  first: boolean
  last: boolean
  go: (link: PlanLink) => void
}

function ItemLine({ row, asOf, first, last, go }: ItemLineProps) {
  const { colors } = useTheme()
  const locale = useLocale()
  const { ring, onFocus, onBlur } = useFocusRing()
  const top = first ? RADII.card : 0
  const bottom = last ? RADII.card : 0
  const edge: ViewStyle = {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderLeftWidth: LINE_WIDTH,
    borderRightWidth: LINE_WIDTH,
    borderTopWidth: first ? LINE_WIDTH : 0,
    borderBottomWidth: last ? LINE_WIDTH : 0,
    borderTopLeftRadius: top,
    borderTopRightRadius: top,
    borderBottomLeftRadius: bottom,
    borderBottomRightRadius: bottom,
  }
  const hover = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { backgroundColor: colors.surface2 } : null)
  // The schedule to the last step's end, the accounts and an installment's statements billed, under the name across the row.
  const schedule = scheduleWords({ ...row.item, ends_on: row.ends_on }, asOf, locale)
  const detail: Copy = [{ text: `${schedule}${row.route.length > 0 ? ' · ' : ''}` }, ...row.route, ...(row.progress ? [{ text: ` · ${row.progress.billed} of ${row.progress.total} billed` }] : [])]
  return (
    <Pressable
      role="button"
      onPress={() => go(row.link)}
      onFocus={onFocus}
      onBlur={onBlur}
      style={(s) => [edge, { minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[3], flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3] }, hover(s), ring && { ...ring, outlineOffset: -2 }]}
    >
      {first ? null : <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} />}
      <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
        {/* The name and its chips wrap in their own column; the amount keeps its width beside them. */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', columnGap: SPACE[3] }}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[2], rowGap: SPACE[1] }}>
            <Text variant="headline" style={{ flexShrink: 1 }}>
              {row.item.name}
            </Text>
            {row.chips.map((c) => (
              <Chip key={c}>{c}</Chip>
            ))}
          </View>
          <View style={{ flexShrink: 0, maxWidth: '60%', alignItems: 'flex-end' }}>
            <Money minor={row.amount.minor} currency={row.amount.currency} style={{ fontWeight: '600' }} />
          </View>
        </View>
        <CopyText copy={detail} variant="footnote" tone="text2" />
        {row.change ? <CopyText copy={row.change} variant="footnote" tone="text2" /> : null}
        {row.earlier ? <CopyText copy={row.earlier} variant="footnote" tone="text2" /> : null}
      </View>
      <View style={{ paddingTop: iconNudge(TYPE.headline.lineHeight, 18) }}>
        <Icon name="chevron-right" size={18} color={colors.text3} />
      </View>
    </Pressable>
  )
}
