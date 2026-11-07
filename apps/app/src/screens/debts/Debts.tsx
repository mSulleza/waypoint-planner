import type { Copy } from '@waypoint/core'
import { useRouter } from 'expo-router'
import { useMemo, type ReactNode } from 'react'
import { Pressable, useWindowDimensions, View, type PressableStateCallbackType, type TextStyle, type ViewStyle } from 'react-native'
import { useEngine, useSnapshot } from '@/data/hooks'
import { shortDay } from '@/data/status'
import { Missing } from '@/shell/Missing'
import { monthTitle, shortMonth } from '@/shell/url.model'
import { AccountTile } from '@/ui/AccountTile'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { CopyText, useCopyWords } from '@/ui/CopyText'
import { EmptyState } from '@/ui/EmptyState'
import { Hero, HeroEyebrow, HeroFigure, HeroRow } from '@/ui/Hero'
import { axisMonth, StackedChart } from '@/ui/chart/StackedChart'
import { Money } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Row } from '@/ui/Row'
import { QuietStatus, Text } from '@/ui/Text'
import { useFocusRing, useLocale, useTheme } from '@/ui/theme'
import { CARD_PADDING, GUTTER, identityColor, LINE_WIDTH, ROW_MIN_HEIGHT, SPACE, TEXT_GAP, TILE } from '@/ui/tokens'
import { RECORD_PAYMENT } from '../today/today.model'
import { ADD_DEBT, CHIPS, debtDetail, debtPanes, debtsModel, type DebtPane, NEXT_CYCLES, type CardDetail, type Chip, type CycleLine, type DebtLink, type DebtRow, type DebtsModel, type LoanDetail, type StateWord } from './debts.model'

// No-break spaces keep each amount with its words when a line wraps.
const NB = ' '

// A day kept on one line inside running text: '20 Sep' never breaks between its parts.
const dayText = (day: string, locale: string, withYear?: boolean) => shortDay(day, locale, withYear).replace(/ /g, NB)

// Wide enough for the next cycles as a five-column table; narrower windows list them.
const TABLE_MIN_WIDTH = 640

// '20 Sep', '20 Sep and 25 Sep', '1 Sep, 20 Sep and 25 Sep'.
function listOf(words: readonly string[]): string {
  return words.length <= 2 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

function useGo(): (link: DebtLink) => void {
  const router = useRouter()
  return (link) => router.push(link)
}

function Failed({ message }: { message: string }) {
  const { refetch } = useSnapshot()
  return <Banner tone="negative" title="Could not work out the projection" body={message} action={{ label: 'Retry', icon: 'rotate-cw', onPress: refetch }} />
}

const errorsOf = (errors: readonly (string | { message: string })[]) => errors.map((e) => (typeof e === 'string' ? e : e.message)).join(' ')

// Spec §7 Debts: the debt-free month first, then revolving cleared and total debt, then each card and loan with its next payment.
export function DebtsTab() {
  const run = useEngine()
  const go = useGo()
  const model = useMemo(() => (run?.ok ? debtsModel(run.world.snapshot, run.walk) : null), [run])
  const panes = useMemo(() => (run?.ok ? debtPanes(run.world.snapshot, run.walk) : []), [run])
  if (!run) return null
  if (!run.ok) return <Failed message={errorsOf(run.errors)} />
  if (!model) {
    return (
      <Card>
        <EmptyState title="No debts" body="Add a card or loan to see your debt-free month." action={{ label: 'Add a debt', onPress: () => go(ADD_DEBT) }} />
      </Card>
    )
  }
  const extra = model.try_extra
  return (
    <View style={{ gap: SPACE[6] }}>
      <View style={{ gap: SPACE[3] }}>
        <Summary m={model} />
        {/* Under the hero, as the mockup sets them: the tonal Try extra payments, then Add a debt. */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE[2] }}>
          {extra ? <Button label="Try extra payments" variant="tonal" onPress={() => go(extra)} /> : null}
          <View style={extra ? null : { marginLeft: -GUTTER }}>
            <Button label="Add a debt" icon="plus" variant="plain" onPress={() => go(ADD_DEBT)} />
          </View>
        </View>
        {panes.map((p) => (
          <DebtChart key={p.currency} pane={p} />
        ))}
      </View>
      <View style={{ gap: SPACE[3] }}>
        <Heading title="Cards and loans" />
        {model.debts.map((d) => (
          <DebtCard key={d.account_id} row={d} go={go} />
        ))}
      </View>
    </View>
  )
}

// Owed month by month, one stack per debt in its card's colour, with the month revolving balances clear.
function DebtChart({ pane }: { pane: DebtPane }) {
  const words = useCopyWords()
  const locale = useLocale()
  const { scheme } = useTheme()
  const end = pane.days.at(-1) ?? ''
  const series = pane.series.map((s) => ({ id: s.account_id, label: words({ account: s.account_id }), colour: identityColor(s.colour, scheme), values: s.owed, clears_at: s.clears_at }))
  const order = [...pane.series].sort((a, b) => a.colour - b.colour).map((s) => s.account_id)
  const at = pane.revolving_at
  return (
    <Card>
      <StackedChart
        currency={pane.currency}
        locale={locale}
        days={pane.days}
        series={series}
        order={order}
        marker={at === null ? null : { index: at, label: `Revolving cleared ${axisMonth(pane.days[at] ?? end, locale)}` }}
        title={pane.free_month ? `Debt-free by ${shortMonth(pane.free_month, locale)}` : `Still owed in ${shortMonth(end.slice(0, 7), locale)}`}
        subtitle="Owed at each month end, by debt"
      />
    </Card>
  )
}

function Heading({ title, children, level = 2 }: { title: string; children?: ReactNode; level?: 2 | 3 }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: SPACE[3], rowGap: SPACE[1] }}>
      <Text variant={level === 2 ? 'title2' : 'headline'} level={level}>
        {title}
      </Text>
      {children}
    </View>
  )
}

// The big answer: a label above the month in hero figures, read as one heading.
function Answer({ label, value, note }: { label: string; value: Copy; note: Copy | null }) {
  const words = useCopyWords()
  const said = `${label} ${value.map((p) => ('money' in p ? '' : words(p))).join('')}`
  return (
    <View style={{ gap: SPACE[1] }}>
      <View role="heading" aria-level={2} aria-label={said}>
        <HeroEyebrow aria-hidden>{label}</HeroEyebrow>
        <HeroFigure copy={value} />
      </View>
      {note ? <CopyText copy={note} variant="subhead" tone="onBrand2" /> : null}
    </View>
  )
}

const heroNote = (note: string | undefined) =>
  note ? (
    <Text variant="footnote" tone="onBrand2">
      {note}
    </Text>
  ) : undefined

// Total debt counts installments not yet billed, so the note says so when the rows' owed amounts do not add up to it.
function totalNote(installments: boolean, cuts: readonly string[]): string | undefined {
  if (cuts.length === 0) return undefined
  return installments ? `Owed plus installments still to bill, from the card statements of ${listOf(cuts)}` : `From the card statements of ${listOf(cuts)}`
}

// The debt-free month as the screen's one Cobalt hero, with revolving cleared and total debt under it.
function Summary({ m }: { m: DebtsModel }) {
  const locale = useLocale()
  const cuts = m.statement_cuts.map((d) => dayText(d, locale))
  const strong = { fontWeight: '700' } as const
  return (
    <Hero>
      <Answer label={m.headline.label} value={m.headline.value} note={m.headline.note} />
      <View style={{ marginTop: SPACE[4], gap: SPACE[3] }}>
        {m.revolving ? (
          <HeroRow label="Revolving cleared" note={<CopyText copy={m.revolving.note} variant="footnote" tone="onBrand2" />}>
            <CopyText copy={m.revolving.value} months="short" variant="headline" tone="onBrand" style={strong} />
          </HeroRow>
        ) : null}
        <HeroRow label="Total debt" note={heroNote(totalNote(m.total_includes_installments, cuts))}>
          {m.total.map((t) => (
            <Money key={t.currency} minor={t.minor} currency={t.currency} variant="headline" tone="onBrand" style={strong} />
          ))}
        </HeroRow>
      </View>
    </Hero>
  )
}

function Word({ w, due }: { w: StateWord; due?: string | null }) {
  const locale = useLocale()
  // Paid names the payment it means, so it never reads as the next one paid; done, it reads quietly.
  if (w.tone === 'positive') return <QuietStatus variant="footnote">{due ? `${dayText(due, locale)} payment paid` : w.text}</QuietStatus>
  if (w.tone) return <Pill tone={w.tone}>{w.text}</Pill>
  return (
    <Text variant="footnote" tone="text2">
      {w.text}
    </Text>
  )
}

// A card's state as a pill: Checked, Provisional and Over limit on their status fills, Total only neutral with its page icon.
function ChipPill({ chip }: { chip: Chip }) {
  return chip.tone ? <Pill tone={chip.tone}>{chip.text}</Pill> : <Pill tone="neutral" icon="file-text">{chip.text}</Pill>
}

function Chips({ row }: { row: DebtRow }) {
  if (row.chips.length === 0) return null
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: SPACE[2] }}>
      {row.chips.map((c) => (
        <ChipPill key={c.text} chip={c} />
      ))}
    </View>
  )
}

// Under the name: 'Card · statement of Sep 20' or 'Loan · 4.25% a year'.
function kindLine(row: DebtRow, locale: string): string {
  if (row.kind === 'loan') return row.annual_rate !== null ? `Loan · ${percent(row.annual_rate, locale)} a year` : 'Loan'
  return row.statement_cut ? `Card · statement of ${dayText(row.statement_cut, locale)}` : 'Card'
}

const percent = (rate: number, locale: string) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 3 }).format(rate)

function Warnings({ words }: { words: readonly string[] }) {
  if (words.length === 0) return null
  return (
    <View style={{ gap: SPACE[1] }}>
      {words.map((w) => (
        <Pill key={w} tone="caution">
          {w}
        </Pill>
      ))}
    </View>
  )
}

// The next payment as a sentence: '₱45,000.00 by 16 Oct', with the remaining due when it differs and the state of a cycle that needs nothing more.
function NextLine({ row }: { row: DebtRow }) {
  const locale = useLocale()
  const n = row.next
  const loan = row.kind === 'loan'
  if (row.action?.label === 'Enter statement') {
    return (
      <Text variant="subhead" tone="text2">
        Enter the statement cut on {dayText(row.statement_cut ?? '', locale)} to see what to pay.
      </Text>
    )
  }
  return (
    <View style={{ gap: SPACE[1] }}>
      {row.state && (row.state.text !== 'Overdue' || !n) ? <Word w={row.state} due={row.state_due} /> : null}
      {n ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: SPACE[2], rowGap: SPACE[1] }}>
          <Text tone="text2">
            {n.after_cut ? `Next:${NB}` : null}
            <Money minor={n.minor} currency={n.currency} variant="headline" style={{ fontWeight: '700' }} />
            {`${NB}${loan ? 'on' : 'by'}${NB}${dayText(n.on, locale)}`}
          </Text>
          {n.overdue ? <Word w={{ text: 'Overdue', tone: 'negative' }} /> : null}
        </View>
      ) : (
        <Text variant="subhead" tone="text2">
          No payment due before the projection ends.
        </Text>
      )}
      {n?.remaining_minor !== null && n?.remaining_minor !== undefined ? (
        <Text variant="footnote" tone="text2">
          {`Remaining due${NB}`}
          <Money minor={n.remaining_minor} currency={n.currency} variant="footnote" tone="text2" />
        </Text>
      ) : null}
      {n?.after_cut ? (
        <Text variant="footnote" tone="text2">
          From the statement cut on {dayText(n.after_cut, locale)}
        </Text>
      ) : null}
    </View>
  )
}

// A press target with the kit's hover, press and focus states; role button, as RNW leaves Enter on a role link to a native anchor.
function Opener({ onPress, children, style }: { onPress: () => void; children: ReactNode; style?: ViewStyle }) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const state = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { backgroundColor: colors.surface2 } : null)
  return (
    <Pressable role="button" onPress={onPress} onFocus={onFocus} onBlur={onBlur} style={(s) => [style, state(s), ring && { ...ring, outlineOffset: -2 }]}>
      {children}
    </Pressable>
  )
}

function DebtCard({ row, go }: { row: DebtRow; go: (link: DebtLink) => void }) {
  const words = useCopyWords()
  const locale = useLocale()
  const { colors } = useTheme()
  const name = words({ account: row.account_id })
  const action = row.action
  // Below zero is a credit, which 'owed' would misstate.
  const credit = row.owed_minor < 0
  return (
    <Card flush>
      <Opener onPress={() => go(row.detail)} style={{ padding: CARD_PADDING, gap: SPACE[3] }}>
        {/* The tile centres on the name and its kind line, as the mockup sets them; the chips keep to the far edge, and the whole card opens the debt. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[3] }}>
          <AccountTile name={name} colour={row.colour} size="large" />
          <View style={{ flex: 1, minWidth: 0, minHeight: TILE.large, justifyContent: 'center', gap: TEXT_GAP }}>
            <Text variant="headline">{name}</Text>
            <Text variant="footnote" tone="text3">
              {kindLine(row, locale)}
            </Text>
          </View>
          <View style={{ flexShrink: 1, alignItems: 'flex-end' }}>
            <Chips row={row} />
          </View>
        </View>
        <View style={{ gap: TEXT_GAP }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: SPACE[2] }}>
            <Money minor={credit ? -row.owed_minor : row.owed_minor} currency={row.currency} variant="amount" />
            <Text variant="subhead" tone="text2" style={{ fontWeight: '500' }}>
              {credit ? 'in credit' : 'owed'}
            </Text>
          </View>
          <CopyText copy={row.payoff} months="short" variant="footnote" tone="text2" />
        </View>
        <Warnings words={row.warnings} />
      </Opener>
      <View style={{ height: LINE_WIDTH, marginHorizontal: CARD_PADDING, backgroundColor: colors.line }} />
      <View style={{ padding: CARD_PADDING, paddingTop: SPACE[3], flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[4], rowGap: SPACE[3] }}>
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 180, gap: SPACE[1] }}>
          <Text variant="caption" tone="text3">
            {row.next?.label ?? 'Next payment'}
          </Text>
          <NextLine row={row} />
        </View>
        {action ? <Button label={action.label} accessibilityLabel={`${action.label} ${name}`} variant="tonal" size="small" onPress={() => go(action.link)} /> : null}
      </View>
    </Card>
  )
}

// Spec §7 Debt detail: a card's latest statement, installments as n of N, the next 6 cycles, interest against the printed figure and statement warnings; a loan's balance, payment, rate and payoff month.
export function DebtDetail({ accountId }: { accountId: string }) {
  const run = useEngine()
  const detail = useMemo(() => (run?.ok ? debtDetail(run.world.snapshot, run.walk, accountId) : null), [run, accountId])
  if (!run) return null
  if (!run.ok) return <Failed message={errorsOf(run.errors)} />
  if (!detail) return <Missing what="debt" list="/debts" listTitle="Debts" />
  return detail.kind === 'loan' ? <Loan d={detail} /> : <CardPage d={detail} />
}

function Actions({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>{children}</View>
}

// What is owed now, the payoff month and the page's buttons; the statement's own chip sits with the statement below.
function Owed({ row, children }: { row: DebtRow; children?: ReactNode }) {
  const over = row.chips.filter((c) => c.text === CHIPS.over_limit.text)
  return (
    <Card style={{ gap: SPACE[4] }}>
      <View style={{ gap: SPACE[2] }}>
        {over.length > 0 ? <Chips row={{ ...row, chips: over }} /> : null}
        <View style={{ gap: SPACE[1] }}>
          <Text variant="subhead" tone="text2">
            {row.owed_minor < 0 ? 'In credit' : 'Owed'}
          </Text>
          <Money minor={row.owed_minor < 0 ? -row.owed_minor : row.owed_minor} currency={row.currency} variant="display" />
        </View>
        <CopyText copy={row.payoff} variant="footnote" tone="text2" />
      </View>
      {children}
    </Card>
  )
}

// One line of a figures card: the label, an optional note, and the amount at the far edge.
function FigureRow({ label, note, divider, children }: { label: string; note?: ReactNode; divider: boolean; children: ReactNode }) {
  const { colors } = useTheme()
  return (
    <View style={{ minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[3], flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[4], rowGap: SPACE[1] }}>
      {divider ? <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} /> : null}
      <View style={{ flexShrink: 1, flexGrow: 1, flexBasis: 140, gap: SPACE[1] }}>
        <Text>{label}</Text>
        {note}
      </View>
      <View style={{ marginLeft: 'auto', alignItems: 'flex-end' }}>{children}</View>
    </View>
  )
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: SPACE[2] }}>
      <Heading title={title}>{aside}</Heading>
      {children}
    </View>
  )
}

function CardPage({ d }: { d: CardDetail }) {
  const go = useGo()
  const locale = useLocale()
  const words = useCopyWords()
  const s = d.statement
  const day = useDayOf()
  const money = (minor: number, variant: 'body' | 'footnote' = 'body') => <Money minor={minor} currency={d.row.currency} variant={variant} tone={variant === 'footnote' ? 'text2' : 'text'} />
  // A balance below zero is a credit: it reads '₱13,000.00 in credit', never with a minus (spec §8).
  const balance = (minor: number) => <Money minor={minor} currency={d.row.currency} owed={minor < 0} />
  const pay = d.row.action?.label === RECORD_PAYMENT ? d.row.action : null
  return (
    <View style={{ gap: SPACE[6] }}>
      <Owed row={d.row}>
        <Actions>
          {pay ? <Button label={RECORD_PAYMENT} variant="tonal" onPress={() => go(pay.link)} /> : null}
          {/* Beside a tonal Record payment it is a plain button, as the mockup pairs them; alone or provisional it is tonal. */}
          <Button label="Enter statement" variant={s.provisional || !pay ? 'tonal' : 'plain'} onPress={() => go({ pathname: '/statement', params: { account: d.row.account_id } })} />
        </Actions>
      </Owed>

      {d.warnings.length > 0 || d.over_limit_minor !== null ? (
        <Section title="Check the statement">
          <Card style={{ gap: SPACE[3] }}>
            {d.over_limit_minor !== null ? (
              <View style={{ gap: SPACE[1] }}>
                <Pill tone="negative">Over the limit</Pill>
                <Text variant="footnote" tone="text2">
                  {`Available credit on the latest statement is${NB}`}
                  {money(-d.over_limit_minor, 'footnote')}
                </Text>
              </View>
            ) : null}
            {d.warnings.map((w) => (
              <View key={w.kind} style={{ gap: SPACE[1] }}>
                <Pill tone="caution">{w.word}</Pill>
                <Text variant="footnote" tone="text2">
                  {`The ${dayText(w.cut_date, locale)} statement prints${NB}`}
                  {money(w.printed_minor, 'footnote')}
                  {`; expected${NB}`}
                  {money(w.expected_minor, 'footnote')}
                </Text>
              </View>
            ))}
            {d.warnings.some((w) => w.kind === 'payments_and_credits') ? (
              <View style={{ alignItems: 'flex-start' }}>
                <Button label="Open transactions" size="small" onPress={() => go(d.links.transactions)} />
              </View>
            ) : null}
          </Card>
        </Section>
      ) : null}

      <Section title="Latest statement" aside={s.chip ? <ChipPill chip={s.chip} /> : undefined}>
        <Card flush>
          <FigureRow label="Cut" divider={false}>
            <Text numbers>{day(s.cut_date)}</Text>
          </FigureRow>
          <FigureRow label="Due" divider>
            <Text numbers>{day(s.due_date)}</Text>
          </FigureRow>
          <FigureRow label="Total" divider>
            {balance(s.total_minor)}
          </FigureRow>
          <FigureRow label="Minimum" divider>
            {money(s.minimum_minor)}
          </FigureRow>
          <FigureRow label="Paid since the cut" divider>
            {money(s.paid_minor)}
          </FigureRow>
          <FigureRow label="Remaining due" divider>
            {balance(s.remaining_minor)}
          </FigureRow>
          {s.left_minor !== s.remaining_minor ? (
            <FigureRow label="Left to pay" divider note={<Text variant="footnote" tone="text2">What the plan pays for this statement from here</Text>}>
              {money(s.left_minor)}
            </FigureRow>
          ) : null}
        </Card>
        {s.provisional ? (
          <Text variant="footnote" tone="text2">
            No statement is entered for this cut, so these are the model’s figures until you enter it.
          </Text>
        ) : null}
      </Section>

      {d.interest ? (
        <Section title="Interest">
          <Card flush>
            <FigureRow label={`Printed on the ${dayText(d.interest.cut_date, locale)} statement`} divider={false}>
              {money(d.interest.printed_minor)}
            </FigureRow>
            <FigureRow label="Modelled from the card terms" divider>
              {money(d.interest.modelled_minor)}
            </FigureRow>
            <FigureRow label="Modelled minus printed" divider>
              <Money minor={d.interest.variance_minor} currency={d.row.currency} signed />
            </FigureRow>
          </Card>
        </Section>
      ) : null}

      {d.installments.length > 0 ? (
        <Section title="Installments">
          <Card flush>
            {d.installments.map((i, k) => (
              <FigureRow
                key={i.plan_item_id}
                label={words({ item: i.plan_item_id })}
                divider={k > 0}
                note={
                  <Text variant="footnote" tone="text2">
                    {`EMI${NB}`}
                    {money(i.amount_minor, 'footnote')}
                    {` a month · last in ${monthTitle(i.last_month, locale)}`}
                  </Text>
                }
              >
                <Text numbers style={{ fontWeight: '600' }}>{`${i.billed} of ${i.total}`}</Text>
              </FigureRow>
            ))}
          </Card>
        </Section>
      ) : null}

      <Section title={`Next ${NEXT_CYCLES} cycles`}>
        {d.cycles.length > 0 ? (
          <Cycles cycles={d.cycles} currency={d.row.currency} />
        ) : (
          <Card>
            <Text tone="text2">No more statements before the projection ends.</Text>
          </Card>
        )}
      </Section>

      <Links d={d} />
    </View>
  )
}

// The card's or loan's transactions, and its terms in the account editor.
function Links({ d }: { d: CardDetail | LoanDetail }) {
  const go = useGo()
  return (
    <Card flush>
      <Row title="Transactions" onPress={() => go(d.links.transactions)} />
      <Row title="Edit terms" divider onPress={() => go(d.links.edit)} />
    </Card>
  )
}

// A day with its year only when the year is not this one.
function useDayOf(): (day: string) => string {
  const locale = useLocale()
  const asOf = useSnapshot().snapshot?.as_of ?? ''
  return (day) => dayText(day, locale, day.slice(0, 4) !== asOf.slice(0, 4))
}

// A table from 640 px, so each figure lines up under its heading; a list on phones.
function Cycles({ cycles, currency }: { cycles: readonly CycleLine[]; currency: string }) {
  const wide = useWindowDimensions().width >= TABLE_MIN_WIDTH
  return wide ? <CycleTable cycles={cycles} currency={currency} /> : <CycleList cycles={cycles} currency={currency} />
}

const COLUMNS = ['Total', 'Minimum', 'Payment', 'Interest'] as const
const figuresOf = (c: CycleLine) => [c.total_minor, c.minimum_minor, c.payment_minor, c.interest_minor]

function CycleTable({ cycles, currency }: { cycles: readonly CycleLine[]; currency: string }) {
  const locale = useLocale()
  const dayOf = useDayOf()
  const { colors } = useTheme()
  const row: ViewStyle = { flexDirection: 'row', alignItems: 'center', minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[2], gap: SPACE[3] }
  const first: TextStyle & ViewStyle = { flexGrow: 1.2, flexBasis: 0 }
  const cell: TextStyle & ViewStyle = { flexGrow: 1, flexBasis: 0, alignItems: 'flex-end' }
  return (
    <Card flush>
      <View role="table" aria-label={`Next ${NEXT_CYCLES} cycles`}>
        <View role="row" style={[row, { minHeight: 40, backgroundColor: colors.surface2 }]}>
          <Text role="columnheader" variant="footnote" tone="text2" style={[first, { fontWeight: '600' }]}>
            Statement
          </Text>
          {COLUMNS.map((c) => (
            <Text key={c} role="columnheader" variant="footnote" tone="text2" style={[cell, { textAlign: 'right', fontWeight: '600' }]}>
              {c}
            </Text>
          ))}
        </View>
        {cycles.map((c) => (
          <View key={c.cut_date} role="row" style={[row, { borderTopWidth: LINE_WIDTH, borderTopColor: colors.line }]}>
            <View role="rowheader" style={first}>
              <Text variant="subhead" numbers>
                {dayOf(c.cut_date)}
              </Text>
              <Text variant="footnote" tone="text2" numbers>
                Due {dayText(c.due_date, locale)}
              </Text>
            </View>
            {figuresOf(c).map((minor, k) => (
              <View key={COLUMNS[k]} role="cell" style={cell}>
                <Money minor={minor} currency={currency} variant="subhead" owed={k === 0 && minor < 0} style={k === 2 ? { fontWeight: '600' } : undefined} />
              </View>
            ))}
          </View>
        ))}
      </View>
    </Card>
  )
}

function CycleList({ cycles, currency }: { cycles: readonly CycleLine[]; currency: string }) {
  const locale = useLocale()
  const dayOf = useDayOf()
  const { colors } = useTheme()
  const money = (minor: number) => <Money minor={minor} currency={currency} variant="footnote" tone="text2" owed={minor < 0} />
  return (
    <Card flush>
      {cycles.map((c, i) => (
        <View key={c.cut_date} style={{ minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[3], gap: SPACE[1] }}>
          {i > 0 ? <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} /> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: SPACE[3], rowGap: SPACE[1] }}>
            <View style={{ flexShrink: 1, gap: SPACE[1] }}>
              <Text>{`Statement ${dayOf(c.cut_date)}`}</Text>
              <Text variant="footnote" tone="text2">{`Due ${dayText(c.due_date, locale)}`}</Text>
            </View>
            <View style={{ marginLeft: 'auto', alignItems: 'flex-end', gap: SPACE[1] }}>
              <Money minor={c.payment_minor} currency={currency} style={{ fontWeight: '600' }} />
              <Text variant="footnote" tone="text2">
                Payment
              </Text>
            </View>
          </View>
          <Text variant="footnote" tone="text2">
            {`Total${NB}`}
            {money(c.total_minor)}
            {` · Minimum${NB}`}
            {money(c.minimum_minor)}
            {` · Interest${NB}`}
            {money(c.interest_minor)}
          </Text>
        </View>
      ))}
    </Card>
  )
}

function Loan({ d }: { d: LoanDetail }) {
  const go = useGo()
  const locale = useLocale()
  const dayOf = useDayOf()
  const pay = d.row.action
  const money = (minor: number) => <Money minor={minor} currency={d.row.currency} />
  const n = d.row.next
  return (
    <View style={{ gap: SPACE[6] }}>
      <Owed row={d.row}>
        {pay ? (
          <Actions>
            <Button label={RECORD_PAYMENT} variant="tonal" onPress={() => go(pay.link)} />
          </Actions>
        ) : null}
      </Owed>
      <Section title="Terms">
        <Card flush>
          <FigureRow label="Payment" divider={false} note={<Text variant="footnote" tone="text2">{`On day ${d.payment_day} of each month`}</Text>}>
            {money(d.payment_minor)}
          </FigureRow>
          <FigureRow label="Rate" divider>
            <Text numbers>{`${percent(d.row.annual_rate ?? 0, locale)} a year`}</Text>
          </FigureRow>
        </Card>
      </Section>
      <Section title="Next payment">
        <Card style={{ gap: SPACE[1] }}>
          {n ? (
            <>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: SPACE[2], rowGap: SPACE[1] }}>
                <Text>
                  <Money minor={n.minor} currency={n.currency} variant="headline" />
                  {`${NB}on${NB}${dayOf(n.on)}`}
                </Text>
                {n.overdue ? <Word w={{ text: 'Overdue', tone: 'negative' }} /> : null}
              </View>
            </>
          ) : (
            <Text tone="text2">No payment due before the projection ends.</Text>
          )}
        </Card>
      </Section>
      <Links d={d} />
    </View>
  )
}
