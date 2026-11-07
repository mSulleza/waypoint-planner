import type { Snapshot, Walk } from '@waypoint/core'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Platform, Pressable, View, type PressableStateCallbackType } from 'react-native'
import { useEngine, useSnapshot } from '@/data/hooks'
import { shortDay } from '@/data/status'
import { useScreenScroll } from '@/shell/Screen'
import { chartSpan, monthsState, monthTitle, type ChartSpan, type MonthView } from '@/shell/url.model'
import { AccountTile } from '@/ui/AccountTile'
import { Banner } from '@/ui/Banner'
import { Card } from '@/ui/Card'
import { LineChart } from '@/ui/chart/LineChart'
import type { ChartSeries } from '@/ui/chart/scale'
import { ZoomBar } from '@/ui/chart/ZoomBar'
import { chartDays, fullRange, zoomAt, type ChartZoom, type DayRange } from '@/ui/chart/zoom'
import { Choices } from '@/ui/Choices'
import { EmptyState } from '@/ui/EmptyState'
import { FromTo, fromToWidths, Money, type FromToWidths } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Segmented } from '@/ui/Segmented'
import { Text } from '@/ui/Text'
import { MIN_TARGET, useFocusRing, useLocale, useTheme } from '@/ui/theme'
import { useIdentity } from '@/ui/useIdentity'
import { GUTTER, identityColor, LINE_WIDTH, ROW_MIN_HEIGHT, SPACE, WORD_TONE } from '@/ui/tokens'
import { cashAccounts, clampMonth, monthPanes, monthSummary, paneSummary, paneTitle, planPanes, strip, type AccountMonth, type MonthKind, type Pane, type Words } from './months.model'
import { Breakdown } from './Breakdown'
import { Strip, stripFocus } from './Strip'
import { Todo } from './Todo'

const VIEWS: readonly { value: MonthView; label: string }[] = [
  { value: 'todo', label: 'To-do' },
  { value: 'breakdown', label: 'Breakdown' },
  { value: 'chart', label: 'Chart' },
]

const KIND_WORD: Record<MonthKind, string> = { past: 'Past', current: 'This month', projected: 'Projected' }

interface Address {
  month: string
  view: MonthView
  span: ChartSpan
}

// Set when an alert opens the chart, so the chart scrolls into view once it has drawn.
const chartFocus = { pending: false }

// Where the page was when a month change pushed the next screen; that screen opens there, so a tap on a month never jumps to the top.
let carried: { y: number; to: string } | null = null
const addressKey = (p: { month?: string; view?: string; span?: string }) => `${p.month} ${p.view} ${p.span ?? ''}`

// The span rides in the address only while the chart shows the whole plan.
const paramsOf = ({ month, view, span }: Address): Record<string, string> => (view === 'chart' && span === 'plan' ? { month, view, span } : { month, view })

// Spec §7 Months: the strip of month words, the month per currency and account, then To-do, Breakdown or Chart. Month, view and span come only from the URL.
export function Months() {
  const run = useEngine()
  const { refetch } = useSnapshot()
  const router = useRouter()
  const params = useLocalSearchParams<{ month?: string; view?: string; span?: string }>()
  const chips = useMemo(() => (run?.ok ? strip(run.world.snapshot, run.walk) : []), [run])
  const page = useScreenScroll()
  // Once, before the screen's first paint, so it never shows its top first.
  useLayoutEffect(() => {
    if (carried && carried.y > 0 && carried.to === addressKey(params)) page?.scrollTo(carried.y)
    carried = null
  }, [])
  if (!run) return null
  if (!run.ok) {
    const message = run.errors.map((e) => (typeof e === 'string' ? e : e.message)).join(' ')
    return <Banner tone="negative" title="Could not work out the projection" body={message} action={{ label: 'Retry', icon: 'rotate-cw', onPress: refetch }} />
  }
  const snapshot = run.world.snapshot
  const asked = monthsState(params, snapshot.as_of)
  const here: Address = { month: clampMonth(chips, asked.month), view: asked.view, span: chartSpan(params.span) }
  // A month is a new history entry, so Back returns to the last month; the view and span change in place, so the control keeps the focus.
  const go = (next: Partial<Address>) => {
    const to = paramsOf({ ...here, ...next })
    if (to.month === here.month) return router.setParams({ ...to, span: to.span ?? undefined })
    carried = { y: page?.offset() ?? 0, to: addressKey(to) }
    router.push({ pathname: '/months', params: to })
  }
  const hrefOf = (month: string) => `/months?${new URLSearchParams(paramsOf({ ...here, month })).toString()}`
  return (
    <View style={{ gap: SPACE[4] }}>
      <Strip
        chips={chips}
        month={here.month}
        hrefOf={hrefOf}
        onPick={(month) => {
          if (month === here.month) return
          stripFocus.pending = true
          go({ month })
        }}
      />
      <Summary snapshot={snapshot} walk={run.walk} month={here.month} go={go} />
      <Segmented label="View" options={VIEWS} value={here.view} onChange={(view) => view !== here.view && go({ view })} />
      {here.view === 'chart' ? (
        <Chart snapshot={snapshot} walk={run.walk} month={here.month} span={here.span} go={go} />
      ) : here.view === 'breakdown' ? (
        <Breakdown snapshot={snapshot} walk={run.walk} month={here.month} />
      ) : (
        <Todo
          snapshot={snapshot}
          walk={run.walk}
          month={here.month}
          showMonth={(month) => go({ month })}
          showChart={(month) => {
            chartFocus.pending = true
            go({ month, view: 'chart' })
          }}
        />
      )}
    </View>
  )
}

function useWords(snapshot: Snapshot): Words {
  const locale = useLocale()
  return useMemo(() => {
    const names = new Map(snapshot.doc.accounts.map((a) => [a.id, a.name]))
    return { name: (id) => names.get(id) ?? id, day: (day, withYear) => shortDay(day, locale, withYear) }
  }, [snapshot, locale])
}

interface PartProps {
  snapshot: Snapshot
  walk: Walk
  month: string
  go: (next: Partial<Address>) => void
}

function Summary({ snapshot, walk, month, go }: PartProps) {
  const locale = useLocale()
  const words = useWords(snapshot)
  const summary = useMemo(() => monthSummary(snapshot, walk, month), [snapshot, walk, month])
  const range = `${summary.kind === 'current' ? 'Now' : words.day(summary.from, false)} → ${words.day(summary.to, false)}`
  return (
    <View style={{ gap: SPACE[3] }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: SPACE[3] }}>
        <Text variant="title2" level={2}>
          {monthTitle(month, locale)}
        </Text>
        <Text variant="subhead" tone="text2">
          {KIND_WORD[summary.kind]}
        </Text>
      </View>
      {summary.groups.length === 0 ? (
        <Card>
          <NoAccounts snapshot={snapshot} month={month} go={go} />
        </Card>
      ) : (
        summary.groups.map((g) => (
          <View key={g.currency}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: SPACE[3], marginBottom: SPACE[2] }}>
              <Text variant="headline" level={3}>
                {g.currency}
              </Text>
              <Text variant="footnote" tone="text2">
                {range}
              </Text>
            </View>
            <Card flush>
              {g.accounts.map((a, i) => (
                <AccountLine key={a.account_id} a={a} kind={summary.kind} words={words} divider={i > 0} widths={fromToWidths(g.accounts.map((x) => ({ from: x.opening_minor, to: x.closing_minor, currency: x.currency })), locale)} />
              ))}
            </Card>
          </View>
        ))
      )}
    </View>
  )
}

function NoAccounts({ snapshot, month, go }: Omit<PartProps, 'walk'>) {
  const locale = useLocale()
  const opened = cashAccounts(snapshot).reduce<string | null>((d, a) => (d === null || a.opening_date < d ? a.opening_date : d), null)
  const now = snapshot.as_of.slice(0, 7)
  return (
    <EmptyState
      title={`No accounts in ${monthTitle(month, locale)}`}
      body={opened ? `Your first account opened on ${shortDay(opened, locale, true)}, so the months before it have no balances.` : 'Add a cash account to see its balance month by month.'}
      action={{ label: `Show ${monthTitle(now, locale)}`, onPress: () => go({ month: now }) }}
    />
  )
}

// No-break spaces keep each amount with its words when a line wraps.
const NB = ' '

function AccountLine({ a, kind, words, divider, widths }: { a: AccountMonth; kind: MonthKind; words: Words; divider: boolean; widths: FromToWidths }) {
  const { colors } = useTheme()
  const colourOf = useIdentity()
  const money = (minor: number) => <Money minor={minor} currency={a.currency} variant="footnote" tone="text2" />
  const lines: ReactNode[] = []
  if (a.opened_on) lines.push(`Opened ${words.day(a.opened_on, false)}`)
  // Only the parts that moved money: '€40.00 in, €12.00 out', '€40.00 in' or nothing.
  const flows = () => {
    const parts = [a.in_minor > 0 ? <Fragment key="in">{money(a.in_minor)}{`${NB}in`}</Fragment> : null, a.out_minor > 0 ? <Fragment key="out">{money(a.out_minor)}{`${NB}out`}</Fragment> : null].filter((p) => p !== null)
    return parts.flatMap((p, i) => (i > 0 ? [', ', p] : [p]))
  }
  if (kind === 'past') lines.push(a.in_minor > 0 || a.out_minor > 0 ? <>{flows()}</> : 'Nothing recorded')
  if (kind === 'current') {
    // Rule 78: between live and the close, only money still to come, and all of it from the plan.
    const later =
      a.later_rows_minor !== 0 ? (
        <>
          <Money minor={a.later_rows_minor} currency={a.currency} variant="footnote" tone="text2" signed />
          {`${NB}entered for later days`}
        </>
      ) : null
    const planned = a.in_minor > 0 || a.out_minor > 0 ? <>{'Planned' + NB}{flows()}</> : 'Nothing planned'
    lines.push(
      <>
        {planned}
        {later ? ' · ' : null}
        {later}
      </>,
    )
  }
  if (a.lowest_minor !== null && a.lowest_on !== null) {
    const days = (n: number) => `${n}${NB}day${n === 1 ? '' : 's'}`
    lines.push(
      <>
        {'Lowest' + NB}
        {money(a.lowest_minor)}
        {`${NB}on ${words.day(a.lowest_on, false)}`}
        {a.floor_minor === null ? null : a.days_under_floor > 0 ? (
          <>
            {` · ${days(a.days_under_floor)} under the${NB}`}
            {money(a.floor_minor)}
            {`${NB}floor`}
          </>
        ) : (
          <>
            {' · Floor' + NB}
            {money(a.floor_minor)}
          </>
        )}
        {a.target_minor !== null && a.days_under_target > a.days_under_floor ? (
          <>
            {` · ${days(a.days_under_target)} under the${NB}`}
            {money(a.target_minor)}
            {`${NB}target`}
          </>
        ) : null}
      </>,
    )
  }
  return (
    <View style={{ minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[3], flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3] }}>
      {divider ? <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} /> : null}
      <AccountTile name={words.name(a.account_id)} colour={colourOf(a.account_id)} />
      <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
        {/* The figures keep their columns; on a narrow phone they move under the name rather than squeeze it. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: SPACE[3], rowGap: SPACE[1] }}>
          <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
            <Text variant="headline" style={{ flexShrink: 1 }}>
              {words.name(a.account_id)}
            </Text>
            {a.word && a.floor_minor === null && kind !== 'past' ? <NoFloor accountId={a.account_id} name={words.name(a.account_id)} /> : null}
          </View>
          <View style={{ marginLeft: 'auto' }}>
            <FromTo from={a.opening_minor} to={a.closing_minor} currency={a.currency} widths={widths} />
          </View>
        </View>
        {/* The word sits where Today puts it: a pill at the far end of the second line. */}
        {lines.map((line, i) =>
          i === 0 && a.word ? (
            <View key={i} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[2], rowGap: SPACE[1] }}>
              <Text variant="footnote" tone="text2" style={{ flexShrink: 1 }}>
                {line}
              </Text>
              <View style={{ marginLeft: 'auto' }}>
                <Pill tone={WORD_TONE[a.word]}>{a.word}</Pill>
              </View>
            </View>
          ) : (
            <Text key={i} variant="footnote" tone="text2">
              {line}
            </Text>
          ),
        )}
      </View>
    </View>
  )
}

// 'No floor set', as Today says it: a link to the account editor, where a floor is set.
function NoFloor({ accountId, name }: { accountId: string; name: string }) {
  const router = useRouter()
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  return (
    <Pressable
      role="link"
      aria-label={`${name}: no floor set. Set one`}
      onPress={() => router.push({ pathname: '/settings/account/[id]', params: { id: accountId } })}
      onFocus={onFocus}
      onBlur={onBlur}
      // A full target that takes no more room than its line: the extra height reaches into the space around it.
      style={{ alignSelf: 'flex-start', minHeight: MIN_TARGET, justifyContent: 'center', marginVertical: -(MIN_TARGET - 18) / 2 }}
    >
      {/* The hover fill and focus ring hug the words, so they never cover the account name above. */}
      {(s: PressableStateCallbackType & { hovered?: boolean }) => (
        <View style={[{ borderRadius: 4, paddingHorizontal: 4, marginHorizontal: -4 }, s.hovered || s.pressed ? { backgroundColor: colors.brandSoft } : null, ring]}>
          <Text variant="footnote" tone="brandText" style={{ fontWeight: '600' }}>
            No floor set
          </Text>
        </View>
      )}
    </Pressable>
  )
}

function Chart({ snapshot, walk, month, span, go }: PartProps & { span: ChartSpan }) {
  const locale = useLocale()
  const words = useWords(snapshot)
  const top = useRef<View>(null)
  useEffect(() => {
    if (!chartFocus.pending) return
    chartFocus.pending = false
    // The page's scroll padding keeps it clear of the sticky header.
    const timer = setTimeout(() => (Platform.OS === 'web' ? (top.current as unknown as HTMLElement | null)?.scrollIntoView({ block: 'start' }) : undefined), 50)
    return () => clearTimeout(timer)
  }, [])
  const panes = useMemo(() => (span === 'plan' ? planPanes(snapshot, walk) : monthPanes(snapshot, walk, month)), [snapshot, walk, month, span])
  const days = useMemo(() => chartDays(panes.map((p) => ({ startDate: p.startDate, length: Math.max(1, ...p.lines.map((l) => l.points.length)) }))), [panes])
  // One view for every pane, so the euro and peso charts show the same days; a new span, month or set of days starts it over.
  const key = `${span} ${month} ${days.start} ${days.last}`
  const [view, setView] = useState<{ key: string; range: DayRange } | null>(null)
  const range = useMemo(() => (view?.key === key ? view.range : fullRange(days.last)), [view, key, days.last])
  const onRange = useCallback((next: DayRange) => setView({ key, range: next }), [key])
  const zoom = useMemo<ChartZoom>(() => ({ days, range, onRange }), [days, range, onRange])
  const spans: readonly { value: ChartSpan; label: string }[] = [
    { value: 'month', label: monthTitle(month, locale) },
    { value: 'plan', label: 'Whole plan' },
  ]
  return (
    <View ref={top} style={{ gap: SPACE[4] }}>
      <Choices layout="chips" label="Chart span" groups={[{ choices: spans.map((o) => ({ value: o.value, title: o.label })) }]} value={span} onChange={(next) => next !== span && go({ span: next })} />
      {panes.length === 0 ? (
        <Card>
          <NoAccounts snapshot={snapshot} month={month} go={go} />
        </Card>
      ) : (
        <>
          <ZoomBar days={days} range={range} locale={locale} onZoom={(factor) => onRange(zoomAt(range, factor, 0.5, days.last))} onReset={() => onRange(fullRange(days.last))} />
          {panes.map((p) => (
            <PaneChart key={`${p.span} ${p.currency}`} pane={p} words={words} zoom={zoom} />
          ))}
        </>
      )}
    </View>
  )
}

function PaneChart({ pane, words, zoom }: { pane: Pane; words: Words; zoom: ChartZoom }) {
  const { scheme } = useTheme()
  const locale = useLocale()
  const series = useMemo<ChartSeries[]>(
    () => pane.lines.map((l) => ({ id: l.account_id, account_id: l.account_id, label: words.name(l.account_id), colour: identityColor(l.colour, scheme), points: l.points })),
    [pane, words, scheme],
  )
  return (
    <Card>
      <LineChart series={series} floors={pane.floors} startDate={pane.startDate} todayIndex={pane.todayIndex} currency={pane.currency} locale={locale} title={paneTitle(pane, words)} summary={paneSummary(pane, words)} zoom={zoom} />
    </Card>
  )
}
