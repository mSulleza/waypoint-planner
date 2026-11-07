import { MASK, minorDigits, type Copy } from '@waypoint/core'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Pressable, View, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { useEngine, useSnapshot } from '@/data/hooks'
import { shortDay } from '@/data/status'
import { monthTitle, shortMonth } from '@/shell/url.model'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { axisMonth, StackedChart } from '@/ui/chart/StackedChart'
import { CopyText } from '@/ui/CopyText'
import { EmptyState } from '@/ui/EmptyState'
import { Hero, HeroEyebrow, HeroFigure } from '@/ui/Hero'
import { Icon } from '@/ui/icons'
import { Slider } from '@/ui/Slider'
import { Text } from '@/ui/Text'
import { MIN_TARGET, useFocusRing, useLocale, useMask, useTheme } from '@/ui/theme'
import { identityColor, LINE_WIDTH, RADII, SPACE, TEXT_GAP } from '@/ui/tokens'
import { DEFAULT_GROWTH, DEFAULT_LOSS, DEFAULT_RATE, lendingModel, monthLines, monthlyYield, RANGES, readInputs, ROUND_DAYS, ROUND_PAYMENTS, YEARS_PAST_GOAL, type InputParams, type Inputs, type LendingModel, type MonthLine, type PeriodRow, type YearRow } from './lending.model'

const pct = (share: number) => `${Math.round(share * 100)}%`

// Projections are whole units of money: cents would only crowd the table.
function useWhole(currency: string): (minor: number) => string {
  const locale = useLocale()
  const { masked } = useMask()
  return useMemo(() => {
    const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 })
    const unit = 10 ** minorDigits(currency)
    return (minor: number) => (masked ? MASK : fmt.format(Math.round(minor / unit)))
  }, [locale, currency, masked])
}

type Key = keyof Inputs

// The book that replaces your income: the goal month, the what-if controls, how it grows, and the schedule year by year.
export function LendingTab() {
  const run = useEngine()
  const router = useRouter()
  const params = useLocalSearchParams<InputParams>()
  const address = useMemo(() => readInputs(params), [params])
  // A slider's value while it is dragged; the address takes it on release.
  const [draft, setDraft] = useState<Partial<Inputs>>({})
  const said = `${params.loss}|${params.topup}|${params.goal}|${params.rate}|${params.growth}`
  useEffect(() => setDraft({}), [said])
  const inputs = useMemo(() => ({ ...address, ...draft }), [address, draft])
  const model = useMemo(() => (run?.ok ? lendingModel(run.world.snapshot, run.walk, inputs) : null), [run, inputs])
  if (!run) return null
  if (!run.ok) return <Failed message={run.errors.map((e) => (typeof e === 'string' ? e : e.message)).join(' ')} />
  if (!model) {
    return (
      <Card>
        <EmptyState title="Nothing lent yet" body="A plan item named 'Lending: …' that pays money out is money you lend, and the book grows from it here." action={{ label: 'Add a plan item', onPress: () => router.push('/plan/item/new?kind=bill') }} />
      </Card>
    )
  }
  const change = (key: Key, value: number) => setDraft((d) => ({ ...d, [key]: value }))
  const commit = (key: Key, value: number) => router.setParams({ [key]: String(value) })
  const reset = () => router.setParams({ loss: undefined, topup: undefined, goal: undefined, rate: undefined, growth: undefined })
  return (
    <View style={{ gap: SPACE[6] }}>
      <Summary m={model} />
      <Controls m={model} change={change} commit={commit} reset={reset} />
      <GrowthChart m={model} />
      <PaysChart m={model} />
      <Schedule m={model} />
      <Assumptions m={model} />
    </View>
  )
}

function Failed({ message }: { message: string }) {
  const { refetch } = useSnapshot()
  return <Banner tone="negative" title="Could not work out the projection" body={message} action={{ label: 'Retry', icon: 'rotate-cw', onPress: refetch }} />
}

function Summary({ m }: { m: LendingModel }) {
  const locale = useLocale()
  const whole = useWhole(m.currency)
  const { colors } = useTheme()
  const { buffered, lossless } = m.projection
  const goal: Copy = buffered.goal_day ? [{ month: buffered.goal_day.slice(0, 7) }] : [{ text: 'Not in 30 years' }]
  const reachable = Number.isFinite(buffered.target) && buffered.target > 0
  const first = m.planned[0]?.day
  const stats: { label: string; value: string; note?: string }[] = [
    ...(m.loss > 0 ? [{ label: 'If every borrower pays', value: lossless.goal_day ? shortMonth(lossless.goal_day.slice(0, 7), locale) : 'Not in 30 years' }] : []),
    { label: 'Book it takes', value: reachable ? whole(buffered.target) : 'Out of reach' },
    { label: 'You put in', value: whole(m.put_in_minor), note: reachable && buffered.goal_day ? `Grows to ${whole(buffered.target)}` : undefined },
    m.today_minor > 0
      ? { label: 'Book today', value: whole(m.today_minor), note: reachable ? `${pct(Math.min(1, m.today_minor / buffered.target))} of the way` : undefined }
      : { label: 'First loan', value: first ? shortDay(first, locale, true) : 'Not planned' },
  ]
  return (
    <Hero>
      <View role="heading" aria-level={2} accessibilityLabel={`Replaces your income ${buffered.goal_day ? monthTitle(buffered.goal_day.slice(0, 7), locale) : 'not in 30 years'}`}>
        <HeroEyebrow aria-hidden>Replaces your income</HeroEyebrow>
        <HeroFigure copy={goal} />
      </View>
      <Text variant="subhead" tone="onBrand2">
        {`${whole(m.goal_then_minor)} a month${m.goal_then_minor !== m.goal_minor ? ` by then, ${whole(m.goal_minor)} today with ${m.salary_growth}% raises a year` : ''}${m.loss > 0 ? `, after a ${m.loss}% a year loss buffer` : ''}`}
      </Text>
      <View style={{ marginTop: SPACE[4], paddingTop: SPACE[4], borderTopWidth: LINE_WIDTH, borderTopColor: colors.heroLine, flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[4], rowGap: SPACE[4] }}>
        {stats.map((s) => (
          <View key={s.label} style={{ flexGrow: 1, flexBasis: 120, gap: TEXT_GAP }}>
            <Text variant="footnote" tone="onBrand2" style={{ fontWeight: '600' }}>
              {s.label}
            </Text>
            <Text variant="title2" tone="onBrand" numbers>
              {s.value}
            </Text>
            {s.note ? (
              <Text variant="footnote" tone="onBrand2">
                {s.note}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </Hero>
  )
}

interface ControlsProps {
  m: LendingModel
  change: (key: Key, value: number) => void
  commit: (key: Key, value: number) => void
  reset: () => void
}

function Controls({ m, change, commit, reset }: ControlsProps) {
  const locale = useLocale()
  const whole = useWhole(m.currency)
  const unit = 10 ** minorDigits(m.currency)
  const goal = m.goal_minor / unit
  const changed = m.loss !== DEFAULT_LOSS || m.rate !== DEFAULT_RATE || m.salary_growth !== DEFAULT_GROWTH || m.topup_minor !== 0 || m.goal_minor !== m.plan_goal_minor
  const half = { flexGrow: 1, flexBasis: 260 } as const
  return (
    <Card>
      <View style={{ gap: SPACE[4] }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: SPACE[3], rowGap: SPACE[1], minHeight: MIN_TARGET }}>
          <Text variant="headline" level={2}>
            What if
          </Text>
          {changed ? <Button label="Back to your plan" variant="plain" size="small" icon="rotate-cw" onPress={reset} /> : null}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[6], rowGap: SPACE[5] }}>
          <View style={half}>
            <Slider
              label="Top-up a month"
              {...RANGES.topup}
              value={m.topup_minor / unit}
              format={(v) => (v === 0 ? 'None' : `${whole(v * unit)} a month`)}
              onChange={(v) => change('topup', v)}
              onCommit={(v) => commit('topup', v)}
              note={`From ${monthTitle(m.topup_from.slice(0, 7), locale)}${m.topup_after_debts ? ', the month after your last debt' : ''}. To make it real, add it to your plan as 'Lending: top-up' so Waypoint checks you can afford it.`}
            />
          </View>
          <View style={half}>
            <Slider
              label="Loss buffer"
              {...RANGES.loss}
              value={m.loss}
              format={(v) => (v === 0 ? 'None' : `${v}% a year`)}
              onChange={(v) => change('loss', v)}
              onCommit={(v) => commit('loss', v)}
              note="The share of the money out you count as lost each year to borrowers who stop paying."
            />
          </View>
          <View style={half}>
            <Slider
              label="Income to replace"
              {...m.goal_range}
              value={goal}
              format={(v) => `${whole(v * unit)} a month`}
              onChange={(v) => change('goal', v)}
              onCommit={(v) => commit('goal', v)}
              note={m.goal_minor === m.plan_goal_minor ? 'Your committed monthly income with no end date.' : `Your plan's income is ${whole(m.plan_goal_minor)} a month.`}
            />
          </View>
          <View style={half}>
            <Slider
              label="Return per round"
              {...RANGES.rate}
              value={m.rate}
              format={(v) => `${v}% a round`}
              onChange={(v) => change('rate', v)}
              onCommit={(v) => commit('rate', v)}
              note={`One round is ${ROUND_DAYS} days of ${ROUND_PAYMENTS} monthly repayments. The default is ${DEFAULT_RATE}%.`}
            />
          </View>
          <View style={half}>
            <Slider
              label="Salary growth"
              {...RANGES.growth}
              value={m.salary_growth}
              format={(v) => (v === 0 ? 'None' : `${v}% a year`)}
              onChange={(v) => change('growth', v)}
              onCommit={(v) => commit('growth', v)}
              note={`A raise each January from ${monthTitle(m.raise_from.slice(0, 7), locale)}. The income to replace and your monthly top-ups rise with it; the one-off loans stay as planned. Your plan has no raises in it.`}
            />
          </View>
        </View>
      </View>
    </Card>
  )
}

// The book at each month end, split into the money put in and the growth on top, against the book the goal takes.
function GrowthChart({ m }: { m: LendingModel }) {
  const locale = useLocale()
  const whole = useWhole(m.currency)
  const { scheme } = useTheme()
  const g = m.growth
  const p = m.projection
  const day = p.buffered.goal_day
  const at = day ? g.days.findIndex((d) => d >= day) : -1
  const reachable = Number.isFinite(p.buffered.target) && p.buffered.target > 0
  const series = [
    { id: 'put_in', label: 'Put in', colour: identityColor(5, scheme), values: g.put_in, clears_at: null },
    { id: 'growth', label: 'Growth', colour: identityColor(3, scheme), values: g.growth, clears_at: null },
  ]
  const last = g.days.at(-1) ?? p.end
  const endBook = (g.put_in.at(-1) ?? 0) + (g.growth.at(-1) ?? 0)
  const subtitle = day ? `${whole(m.put_in_minor)} put in grows to ${whole(p.buffered.target)} by ${shortMonth(day.slice(0, 7), locale)}. Still topped up and relent, it is ${whole(endBook)} by ${shortMonth(last.slice(0, 7), locale)}.` : 'Book at each month end'
  return (
    <Card>
      <StackedChart
        currency={m.currency}
        locale={locale}
        days={g.days}
        series={series}
        order={['put_in', 'growth']}
        marker={at < 0 ? null : { index: at, label: `Goal ${axisMonth(g.days[at] ?? '', locale)}` }}
        level={reachable ? { value: p.buffered.target, label: `Book it takes ${whole(p.buffered.target)}` } : null}
        title="How the book grows"
        subtitle={subtitle}
      />
    </Card>
  )
}

// What the book would pay each month if its gains were taken out, against the income it should replace.
function PaysChart({ m }: { m: LendingModel }) {
  const locale = useLocale()
  const whole = useWhole(m.currency)
  const { scheme } = useTheme()
  const g = m.growth
  const day = m.projection.buffered.goal_day
  const at = day ? g.days.findIndex((d) => d >= day) : -1
  const pays = g.pays
  const title = day ? `Pays your income from ${monthTitle(day.slice(0, 7), locale)}` : `Pays ${whole(pays.at(-1) ?? 0)} a month in 30 years`
  const last = g.days.at(-1)
  const subtitle = day && last ? `What the book would pay a month if you took its gains out: ${whole(pays.at(-1) ?? 0)} by ${shortMonth(last.slice(0, 7), locale)}` : 'What the book would pay a month if you took its gains out'
  return (
    <Card>
      <StackedChart
        currency={m.currency}
        locale={locale}
        days={g.days}
        series={[{ id: 'pays', label: 'Pays a month', colour: identityColor(0, scheme), values: pays, clears_at: null }]}
        order={['pays']}
        marker={at < 0 ? null : { index: at, label: `Goal ${axisMonth(g.days[at] ?? '', locale)}` }}
        level={m.goal_then_minor > 0 ? { value: m.goal_then_minor, label: m.goal_then_minor !== m.goal_minor && day ? `Your income in ${day.slice(0, 4)} ${whole(m.goal_then_minor)}` : `Your income ${whole(m.goal_minor)}` } : null}
        title={title}
        subtitle={subtitle}
      />
    </Card>
  )
}

interface Column {
  label: string
  value: (r: PeriodRow) => number
}

// One row a year: tap it for the months that have something to do.
function Schedule({ m }: { m: LendingModel }) {
  const [open, setOpen] = useState<string | null>(null)
  const [width, setWidth] = useState(0)
  const whole = useWhole(m.currency)
  const wide = width >= 520
  const columns: Column[] = [
    { label: 'Put in', value: (r) => r.put_in_minor },
    ...(wide ? [{ label: 'Back to relend', value: (r: PeriodRow) => r.back_minor }] : []),
    { label: 'Book at end', value: (r) => r.book_minor },
    { label: 'Pays a month', value: (r) => r.pays_minor },
  ]
  const first = wide ? 88 : 64
  return (
    <View style={{ gap: SPACE[3] }}>
      <View style={{ gap: TEXT_GAP }}>
        <Text variant="title2" level={2}>
          Schedule by year
        </Text>
        <Text variant="footnote" tone="text2">
          Tap a year for its months: when to lend, what comes back to relend, and the milestones. Money relent twice in a year counts twice in Back to relend.
        </Text>
      </View>
      <Card>
        <View onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}>
          <Cells first={first} head>
            {['Year', ...columns.map((c) => c.label)]}
          </Cells>
          {m.years.map((y) => (
            <YearRows key={y.key} y={y} columns={columns} first={first} open={open === y.key} toggle={() => setOpen(open === y.key ? null : y.key)} whole={whole} />
          ))}
        </View>
      </Card>
    </View>
  )
}

// A row of cells: the first a fixed width, the figures sharing the rest and set right.
function Cells({ first, head = false, tone, icon, children }: { first: number; head?: boolean; tone?: 'text2'; icon?: ReactNode; children: readonly string[] }) {
  const [lead, ...rest] = children
  const style = head ? ({ fontWeight: '600' } as const) : undefined
  return (
    <View aria-hidden={head} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: SPACE[2], paddingVertical: head ? SPACE[2] : 0 }}>
      <View style={{ width: first, flexDirection: 'row', alignItems: 'center', gap: SPACE[1] }}>
        <Text variant="footnote" tone={head ? 'text2' : tone} numbers style={{ fontWeight: head || icon ? '600' : '400' }}>
          {lead ?? ''}
        </Text>
        {icon}
      </View>
      {rest.map((t, i) => (
        <Text key={i} variant="footnote" tone={head ? 'text2' : tone} numbers style={[{ flex: 1, textAlign: 'right' }, style]}>
          {t}
        </Text>
      ))}
    </View>
  )
}

interface YearRowsProps {
  y: YearRow
  columns: readonly Column[]
  first: number
  open: boolean
  toggle: () => void
  whole: (minor: number) => string
}

function YearRows({ y, columns, first, open, toggle, whole }: YearRowsProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const locale = useLocale()
  const figures = (r: PeriodRow) => columns.map((c) => (c.value(r) === 0 && c.label !== 'Book at end' ? '–' : whole(c.value(r))))
  const marks = y.lines.flatMap((l) => (l.kind === 'milestone' ? [`${pct(l.share)} of the way`] : l.kind === 'goal' ? [`Goal: pays ${whole(l.monthly_minor)} a month`] : []))
  const said = `${y.key}. ${columns.map((c) => `${c.label} ${whole(c.value(y))}`).join(', ')}.${marks.length > 0 ? ` ${marks.join(', ')}.` : ''}`
  const hover = ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { backgroundColor: colors.surface2 } : null)
  return (
    <View style={{ borderTopWidth: LINE_WIDTH, borderTopColor: colors.line }}>
      <Pressable role="button" aria-expanded={open} aria-label={said} onPress={toggle} onFocus={onFocus} onBlur={onBlur} style={(s) => [{ minHeight: MIN_TARGET, justifyContent: 'center', paddingVertical: SPACE[2], marginHorizontal: -SPACE[2], paddingHorizontal: SPACE[2], borderRadius: RADII.chip, gap: SPACE[1] }, hover(s), ring]}>
        <Cells first={first} icon={<Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} color={colors.text2} />}>
          {[y.key, ...figures(y)]}
        </Cells>
        {marks.length > 0 ? (
          <Text variant="footnote" tone="brandText" style={{ fontWeight: '600' }}>
            {marks.join(' · ')}
          </Text>
        ) : null}
      </Pressable>
      {open ? (
        <View style={{ backgroundColor: colors.surface2, borderRadius: RADII.chip, marginHorizontal: -SPACE[2], paddingHorizontal: SPACE[2], marginBottom: SPACE[2] }}>
          {y.months.map((mo, i) => (
            <View key={mo.key} style={{ paddingVertical: SPACE[2], gap: SPACE[1], borderTopWidth: i === 0 ? 0 : LINE_WIDTH, borderTopColor: colors.line }}>
              <Cells first={first} tone="text2">
                {[shortMonth(mo.key, locale).split(' ')[0] ?? mo.key, ...figures(mo)]}
              </Cells>
              {monthLines(mo.lines).map((l, k) => (
                <View key={k} style={{ flexDirection: 'row', gap: SPACE[2] }}>
                  <Text variant="footnote" tone="text2" numbers style={{ width: first }}>
                    {l.kind === 'relends' ? dayRange(l.day, l.last, locale) : shortDay(l.day, locale)}
                  </Text>
                  <CopyText copy={lineCopy(l, whole)} variant="footnote" style={{ flex: 1 }} />
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

// 'Jan 2 – 31' or '2–31 Jan' as the locale writes it; a phone without formatRange falls back to the first day on.
function dayRange(from: string, to: string, locale: string): string {
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })
  const [a, b] = [new Date(`${from}T00:00:00Z`), new Date(`${to}T00:00:00Z`)]
  return typeof fmt.formatRange === 'function' ? fmt.formatRange(a, b) : `${shortDay(from, locale)} on`
}

function lineCopy(l: MonthLine, whole: (minor: number) => string): Copy {
  switch (l.kind) {
    case 'lend':
      return [{ text: `Lend ${whole(l.minor)}${l.name ? `: ${l.name}` : ''}` }]
    case 'topup':
      return [{ text: `Top up ${whole(l.minor)}, a what-if not in your plan yet` }]
    case 'relend':
      return [{ text: `${whole(l.minor)} comes back from ${l.loans === 1 ? 'one loan' : `${l.loans} loans`}: relend it all` }]
    case 'relends':
      return [{ text: `${whole(l.minor)} comes back from ${l.loans} loans over the month: relend each as it lands` }]
    case 'milestone':
      return [{ text: `${pct(l.share)} of the way: the book would pay ${whole(l.monthly_minor)} a month` }]
    case 'goal':
      return [{ text: `Goal: the book could now pay you ${whole(l.monthly_minor)} a month. Keep topping up and relending` }]
  }
}

function Assumptions({ m }: { m: LendingModel }) {
  const lines = [
    `Each loan earns ${m.rate}% a round: ${ROUND_PAYMENTS} monthly repayments over ${ROUND_DAYS} days. Each round counts here as one step, and everything that comes back is relent.`,
    `The book is for retirement, so the top-ups and relending carry on past the goal. The view runs ${YEARS_PAST_GOAL} years past it.`,
    m.salary_growth > 0 ? `Your salary gets a ${m.salary_growth}% raise each January from ${m.raise_from.slice(0, 4)}. The income to replace and every monthly top-up rise with it, so the goal is the month the book pays your salary as it is then.` : 'Your salary and your top-ups stay as they are today.',
    m.loss > 0 ? `The loss buffer takes ${m.loss}% a year off the money out, so the book then pays ${(monthlyYield(m.loss, m.rate / 100) * 100).toFixed(1)}% a month instead of ${(monthlyYield(0, m.rate / 100) * 100).toFixed(1)}%.` : `With no loss buffer the book pays ${(monthlyYield(0, m.rate / 100) * 100).toFixed(1)}% a month.`,
    'The goal starts from your committed monthly income with no end date. Figures are before tax, at today’s exchange rates.',
    "Money in is every plan item named 'Lending: …' that pays money out, so Waypoint checks you can afford it. The top-up is a what-if until it is in your plan.",
    'A book this size is a lot for one person to lend out. Check the borrowers, the paperwork and the local lending rules as it grows.',
  ]
  return (
    <Card>
      <View style={{ gap: SPACE[2] }}>
        <Text variant="headline" level={2}>
          What this assumes
        </Text>
        {lines.map((t) => (
          <Text key={t} variant="footnote" tone="text2">
            {t}
          </Text>
        ))}
      </View>
    </Card>
  )
}
