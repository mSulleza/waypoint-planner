import type { BudgetRow } from '@waypoint/core'
import { useRouter } from 'expo-router'
import { useMemo, useRef, type ReactNode } from 'react'
import { Pressable, View, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { useBreakeven, useEngine, useSnapshot } from '@/data/hooks'
import { shortDay } from '@/data/status'
import { AccountTile } from '@/ui/AccountTile'
import { AlertLine } from '@/ui/AlertLine'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { CopyText, useCopyWords } from '@/ui/CopyText'
import { EmptyState } from '@/ui/EmptyState'
import { Hero, HeroButton, HeroEyebrow } from '@/ui/Hero'
import { Icon } from '@/ui/icons'
import { FromTo, fromToWidths, Money, useSpokenMoney } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Text } from '@/ui/Text'
import { MIN_TARGET, TYPE, useFocusRing, useLocale, useTheme } from '@/ui/theme'
import { GUTTER, identityColor, LINE_WIDTH, RADII, ROW_MIN_HEIGHT, SPACE, SWATCH, WORD_TONE } from '@/ui/tokens'
import { dayTitle, paceBar, PLAN_EDITOR, todayModel, type AgendaItem, type Section, type TodayLink, type TodayModel } from './today.model'

type Shown = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'ready'; model: TodayModel }

// Nothing until the walk and, in two currencies, the FX breakeven are in; after a save the last figures stay up until the new ones are.
function useToday(): Shown {
  const run = useEngine()
  const breakeven = useBreakeven()
  const fresh = useMemo<Shown | null>(() => {
    if (!run) return null
    if (!run.ok) return { state: 'failed', message: run.errors.map((e) => (typeof e === 'string' ? e : e.message)).join(' ') }
    if (!breakeven.ready) return null
    const found = breakeven.value
    if (found instanceof Error) return { state: 'failed', message: found.message }
    if (found !== null && !found.ok) return { state: 'failed', message: found.errors.map((e) => e.message).join(' ') }
    return { state: 'ready', model: todayModel({ snapshot: run.world.snapshot, walk: run.walk, breakeven: found }) }
  }, [run, breakeven])
  const last = useRef<Shown>({ state: 'loading' })
  if (fresh) last.current = fresh
  return fresh ?? last.current
}

// Spec §7 Today: the next action, the worst alert, cash accounts, budget pace and the next 30 days, in that order on every screen size.
export function Today() {
  const shown = useToday()
  const { refetch } = useSnapshot()
  const router = useRouter()
  if (shown.state === 'loading') return null
  if (shown.state === 'failed') return <Banner tone="negative" title="Could not work out the projection" body={shown.message} action={{ label: 'Retry', icon: 'rotate-cw', onPress: refetch }} />
  const m = shown.model
  const go = (link: TodayLink) => router.push(link)
  const parts: Record<Section, () => ReactNode> = {
    next: () => <NextAction m={m} go={go} />,
    alert: () => <AlertPart m={m} go={go} />,
    cash: () => <Cash m={m} go={go} />,
    budgets: () => <Budgets m={m} go={go} />,
    agenda: () => <Agenda m={m} go={go} />,
  }
  return (
    <View>
      {m.sections.map((s, i) => (
        // The alert sits close under the action it qualifies; the figures below get room of their own.
        <View key={s} style={{ marginTop: i === 0 ? 0 : s === 'alert' ? SPACE[2] : SPACE[4] }}>
          {parts[s]()}
        </View>
      ))}
      {m.empty ? (
        <View style={{ marginTop: m.sections.length > 0 ? SPACE[4] : 0 }}>
          <EmptyState title="Add your income and bills" body="Today works out what to do from your plan: the money coming in, the bills going out and when." action={{ label: 'Add an item', onPress: () => go(PLAN_EDITOR) }} />
        </View>
      ) : null}
    </View>
  )
}

interface PartProps {
  m: TodayModel
  go: (link: TodayLink) => void
}

// 'Next action · today', '· tomorrow' or '· by Fri, Oct 16'; a late one takes a Late pill instead.
function eyebrow(when: TodayModel['next']['when'], asOf: string, locale: string): string {
  if (when.late || when.by === null) return 'Next action'
  const day = dayTitle(when.by, asOf, locale)
  return `Next action · ${day === 'Today' || day === 'Tomorrow' ? day.toLowerCase() : `by ${day}`}`
}

function NextAction({ m, go }: PartProps) {
  const { colors } = useTheme()
  const locale = useLocale()
  const { action, when, detail, later, button } = m.next
  // Nothing to do is one quiet line, not an empty card.
  if (action.kind === 'none') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2] }}>
        <Icon name="circle-check" size={18} color={colors.text3} />
        <CopyText copy={action.title} variant="subhead" tone="text2" />
      </View>
    )
  }
  // The screen's one Cobalt hero: what to do now, in white, with its one button.
  return (
    <Hero>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[2], rowGap: SPACE[1] }}>
        <HeroEyebrow>{eyebrow(when, m.as_of, locale)}</HeroEyebrow>
        {when.late ? <Pill tone="negative">Late</Pill> : null}
      </View>
      <View style={{ marginTop: SPACE[1], gap: SPACE[1] }}>
        <CopyText copy={action.title} variant="title1" tone="onBrand" />
        {detail.length > 0 ? <CopyText copy={detail} variant="subhead" tone="onBrand2" /> : null}
      </View>
      {later ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[2], marginTop: SPACE[3] }}>
          <View style={{ height: TYPE.subhead.lineHeight, justifyContent: 'center' }}>
            <Icon name="calendar" size={16} color={colors.onBrand} />
          </View>
          <CopyText copy={later} variant="subhead" tone="onBrand" style={{ flexShrink: 1, fontWeight: '600' }} />
        </View>
      ) : null}
      {button ? (
        <View style={{ marginTop: SPACE[4] }}>
          <HeroButton label={button.label} onPress={() => go(button.link)} accessibilityLabel={when.late ? `${button.label}, late` : undefined} />
        </View>
      ) : null}
    </Hero>
  )
}

function AlertPart({ m, go }: PartProps) {
  const words = useCopyWords()
  const a = m.alert
  if (!a) return null
  const about = a.about.map((p) => ('money' in p ? '' : words(p))).join('')
  const more = a.more > 0 ? `${a.more} more` : ''
  return (
    <AlertLine
      tone={a.tone}
      title={a.alert.title}
      detail={[about, more].filter(Boolean).join(' · ')}
      onPress={() => go(a.link)}
      accessibilityLabel={`${a.alert.title}${about ? `, ${about}` : ''}. ${a.more > 0 ? `${a.more} more in To-do` : 'Open To-do'}`}
    />
  )
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: SPACE[3], marginBottom: SPACE[2] }}>
      <Text variant="title2" level={2}>
        {title}
      </Text>
      {children}
    </View>
  )
}

const Divider = ({ inset = GUTTER }: { inset?: number }) => {
  const { colors } = useTheme()
  return <View style={{ position: 'absolute', top: 0, left: inset, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} />
}

// A row that opens something when it has somewhere to go; the whole row is the target.
function Line({ style, onPress, label, children }: { style: ViewStyle; onPress?: () => void; label?: string; children: ReactNode }) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  if (!onPress) return <View style={style}>{children}</View>
  const hover = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { backgroundColor: colors.surface2 } : null)
  return (
    <Pressable role="button" aria-label={label} onPress={onPress} onFocus={onFocus} onBlur={onBlur} style={(s) => [style, hover(s), ring && { ...ring, outlineOffset: -2 }]}>
      {children}
    </Pressable>
  )
}

function Cash({ m, go }: PartProps) {
  const locale = useLocale()
  const words = useCopyWords()
  const spoken = useSpokenMoney()
  const widths = useMemo(() => fromToWidths(m.cash.map((c) => ({ from: c.live_minor, to: c.end_minor, currency: c.currency })), locale), [m.cash, locale])
  const end = shortDay(m.month_end, locale)
  return (
    <View>
      <Heading title="Cash accounts">
        <Text variant="footnote" tone="text2">
          Now → {end}
        </Text>
      </Heading>
      <Card flush>
        {m.cash.map((c, i) => {
          const name = words({ account: c.account_id })
          const link = c.floor_link
          const lowest = c.lowest ? `, lowest ${spoken(c.lowest.minor, c.currency)} on ${shortDay(c.lowest.on, locale)}` : ''
          return (
            <Line
              key={c.account_id}
              onPress={link ? () => go(link) : undefined}
              label={`${name}, ${spoken(c.live_minor, c.currency)} now, ${spoken(c.end_minor, c.currency)} on ${end}. ${c.word}${lowest}. No floor set. Set one`}
              style={{ minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[3], flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3] }}
            >
              {i > 0 ? <Divider /> : null}
              <AccountTile name={name} colour={c.colour} />
              <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
                {/* The figures keep their columns; on a narrow phone they move under the name rather than squeeze it. */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[3], rowGap: SPACE[1] }}>
                  <Text variant="headline" style={{ flexGrow: 1, flexShrink: 1 }}>
                    {name}
                  </Text>
                  <View style={{ marginLeft: 'auto' }}>
                    <FromTo from={c.live_minor} to={c.end_minor} currency={c.currency} widths={widths} />
                  </View>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[2], rowGap: SPACE[1] }}>
                  <Text variant="footnote" tone="text3" style={{ flexShrink: 1 }}>
                    {`${c.currency} · `}
                    {link ? (
                      <Text variant="footnote" tone="brandText" style={{ fontWeight: '600' }}>
                        No floor set
                      </Text>
                    ) : c.floor_minor !== null ? (
                      <>
                        {'floor\u00a0'}
                        <Money minor={c.floor_minor} currency={c.currency} variant="footnote" tone="text3" />
                      </>
                    ) : null}
                    {/* A Short or Tight word says where the month dips, which the month-end figure alone does not. */}
                    {c.lowest ? (
                      <>
                        {' · lowest\u00a0'}
                        <Money minor={c.lowest.minor} currency={c.currency} variant="footnote" tone="text3" />
                        {`\u00a0on ${shortDay(c.lowest.on, locale).replace(/ /g, '\u00a0')}`}
                      </>
                    ) : null}
                  </Text>
                  <View style={{ marginLeft: 'auto' }}>
                    <Pill tone={WORD_TONE[c.word]}>{c.word}</Pill>
                  </View>
                </View>
              </View>
            </Line>
          )
        })}
      </Card>
    </View>
  )
}

function Budgets({ m, go }: PartProps) {
  return (
    <View>
      <Heading title="Budgets">
        {/* The button keeps its 44 pt target; the heading line keeps its own height. */}
        <View style={{ marginVertical: -(MIN_TARGET - TYPE.title2.lineHeight) / 2, marginRight: -SPACE[3] }}>
          <Button label="All budgets" variant="plain" size="small" onPress={() => go(m.all_budgets)} />
        </View>
      </Heading>
      <Card flush>
        {m.budgets.map((b, i) => (
          <BudgetPace key={b.category_id} b={b} divider={i > 0} />
        ))}
      </Card>
    </View>
  )
}

// One budget as the mockup draws it: what is left, its pace word and day, the bar against the plan's mark, then the daily rates.
function BudgetPace({ b, divider }: { b: BudgetRow; divider: boolean }) {
  const { colors } = useTheme()
  const words = useCopyWords()
  const spoken = useSpokenMoney()
  const over = b.left_minor < 0
  const bar = paceBar(b)
  const strong = { fontWeight: '600' } as const
  return (
    <View style={{ minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingTop: SPACE[3], paddingBottom: SPACE[4] }}>
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
        {b.word === 'Spending fast' ? (
          <Pill tone="caution">{b.word}</Pill>
        ) : b.word ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[1] }}>
            <Icon name="gauge" size={14} color={colors.text2} strokeWidth={2.4} />
            <Text variant="footnote" tone="text2" style={strong}>
              {b.word}
            </Text>
          </View>
        ) : null}
        <Text variant="footnote" tone="text3" numbers style={{ marginLeft: 'auto' }}>
          {`Day ${b.days_elapsed} of ${b.days_in_month}`}
        </Text>
      </View>
      <View role="img" aria-label={`Spent ${spoken(b.spent_minor, b.currency)} of ${spoken(b.budget_minor, b.currency)}. The plan by today is ${spoken(bar.plan_minor, b.currency)}.`} style={{ height: BAR_HEIGHT, marginTop: SPACE[3], borderRadius: RADII.pill, backgroundColor: colors.surface2 }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${bar.spent * 100}%`, borderRadius: RADII.pill, backgroundColor: colors[bar.fill] }} />
        {/* The plan's mark stands proud of the bar, ringed in the card's colour so it reads over the fill. */}
        <View style={{ position: 'absolute', left: `${bar.mark * 100}%`, top: -(MARK_REACH + MARK_RING), width: MARK_WIDTH + 2 * MARK_RING, height: BAR_HEIGHT + 2 * (MARK_REACH + MARK_RING), transform: [{ translateX: -(MARK_WIDTH / 2 + MARK_RING) }], borderRadius: RADII.pill, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: MARK_WIDTH, height: BAR_HEIGHT + 2 * MARK_REACH, borderRadius: MARK_RING, backgroundColor: colors.text }} />
        </View>
      </View>
      <View style={{ marginTop: SPACE[3] }}>
        <Text variant="footnote" tone="text2">
          {/* No-break spaces keep each amount with its words when the line wraps. */}
          <Money minor={b.rate_so_far_minor} currency={b.currency} variant="footnote" style={strong} />
          {'\u00a0a day so far, plan\u00a0'}
          <Money minor={b.planned_rate_minor} currency={b.currency} variant="footnote" style={strong} />
        </Text>
        <Text variant="footnote" tone="text2">
          <Money minor={b.per_day_minor} currency={b.currency} variant="footnote" tone="text2" />
          {'\u00a0a day from here'}
        </Text>
      </View>
    </View>
  )
}

// The pace bar is 10 tall; the plan's 3 wide mark reaches 4 past it each way, inside a 2 wide ring.
const BAR_HEIGHT = 10
const MARK_WIDTH = 3
const MARK_REACH = 4
const MARK_RING = 2

function Agenda({ m, go }: PartProps) {
  const locale = useLocale()
  const several = m.cash.length > 1
  return (
    <View>
      <Heading title="Next 30 days">
        <Text variant="footnote" tone="text2">
          Balance after, with daily spending
        </Text>
      </Heading>
      {m.agenda.length === 0 ? (
        <Card>
          <EmptyState title="Nothing in the next 30 days" body="Bills, income and transfers you plan show here by day, with the balance after each." action={{ label: 'Add an item', onPress: () => go(PLAN_EDITOR) }} />
        </Card>
      ) : (
        <Card flush>
          {m.agenda.map((day, d) => (
            <View key={day.date}>
              {d > 0 ? <Divider inset={0} /> : null}
              <Text variant="caption" tone="text3" level={3} style={{ paddingHorizontal: GUTTER, paddingTop: SPACE[3] }}>
                {dayTitle(day.date, m.as_of, locale)}
              </Text>
              {day.items.map((item) => (
                <AgendaLine key={item.id} item={item} day={dayTitle(day.date, m.as_of, locale)} several={several} go={go} />
              ))}
            </View>
          ))}
        </Card>
      )}
    </View>
  )
}

function AgendaLine({ item, day, several, go }: { item: AgendaItem; day: string; several: boolean; go: (link: TodayLink) => void }) {
  const words = useCopyWords()
  const spoken = useSpokenMoney()
  const title = item.title.map((p) => ('money' in p ? '' : words(p))).join('')
  const where = item.to_account_id ? `${words({ account: item.account_id })} → ${words({ account: item.to_account_id })}` : several ? words({ account: item.account_id }) : ''
  // A move that landed here is listed on the account it left, so the balance after says it took it in.
  const landed = item.landed.map((l) => `After the ${l.kind === 'top_up' ? 'top-up' : 'transfer'} from ${words({ account: l.from_account_id })}`)
  const detail = [where, ...item.words, ...landed].filter(Boolean).join(' · ')
  const record = item.record
  return (
    <Line
      onPress={record ? () => go(record) : undefined}
      // Every part a sighted reader sees, amounts through the same formatter, so the eye hides them here too.
      label={`${title}, ${day}${detail ? `, ${detail}` : ''}, ${spoken(item.amount_minor, item.currency, true)}, balance after ${spoken(item.after_minor, item.currency)}. Record`}
      style={{ minHeight: ROW_MIN_HEIGHT, flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3], paddingHorizontal: GUTTER, paddingVertical: SPACE[2] }}
    >
      {/* The listed account's colour beside the name that says it; with one cash account no name shows, so no swatch either. */}
      {where ? <Swatch colour={item.colour} lineHeight={TYPE.body.lineHeight} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={STRONG}>{title}</Text>
        {detail || record ? (
          <Text variant="footnote" tone="text3">
            {detail}
            {record ? (
              <Text variant="footnote" tone="brandText" style={{ fontWeight: '600' }}>
                {detail ? ' · ' : ''}Record
              </Text>
            ) : null}
          </Text>
        ) : null}
      </View>
      <View style={{ flexShrink: 0, maxWidth: '55%', alignItems: 'flex-end' }}>
        <Money minor={item.amount_minor} currency={item.currency} signed style={STRONG} />
        <Money minor={item.after_minor} currency={item.currency} variant="footnote" tone="text3" />
      </View>
    </Line>
  )
}

const STRONG = { fontWeight: '600' } as const

// An account's 10 pt identity swatch, centred on the first line beside it; screen readers skip it, as the name says which account.
function Swatch({ colour, lineHeight }: { colour: number; lineHeight: number }) {
  const { scheme } = useTheme()
  return <View aria-hidden style={{ width: SWATCH.size, height: SWATCH.size, borderRadius: SWATCH.radius, marginTop: (lineHeight - SWATCH.size) / 2, backgroundColor: identityColor(colour, scheme) }} />
}
