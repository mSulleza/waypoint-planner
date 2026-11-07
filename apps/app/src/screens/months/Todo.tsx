import type { Snapshot, Walk } from '@waypoint/core'
import { useRouter } from 'expo-router'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, View, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { useBreakeven, useSnapshot } from '@/data/hooks'
import { shortDay } from '@/data/status'
import { useEdit } from '@/data/useEdit'
import type { Edit } from '@/data/edits'
import { monthTitle } from '@/shell/url.model'
import { AlertRow } from '@/ui/AlertLine'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { CopyText, useCopyWords } from '@/ui/CopyText'
import { EmptyState } from '@/ui/EmptyState'
import { Money } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Row } from '@/ui/Row'
import { Sheet } from '@/ui/Sheet'
import { QuietStatus, Text } from '@/ui/Text'
import { useFocusOnMount, useFocusRing, useLocale, useTheme } from '@/ui/theme'
import { GUTTER, LINE_WIDTH, ROW_MIN_HEIGHT, SPACE } from '@/ui/tokens'
import { PLAN_EDITOR, type TodayLink } from '../today/today.model'
import { DONE_FOR_MONTH, linkChoices, SECTION_TITLES, todoModel, type CardRow, type ItemRow, type LinkedRow, type RowWord, type TodoAlert, type TodoModel, type TopUpRow } from './todo.model'

export interface TodoProps {
  snapshot: Snapshot
  walk: Walk
  month: string
  // Opens another month of Months, as the strip does.
  showMonth: (month: string) => void
  // Opens a month's chart and brings it into view, as an alert about a short month does.
  showChart: (month: string) => void
}

type Step = 'actions' | 'link' | 'confirm'
interface Open {
  row: ItemRow
  step: Step
  // The linked row Delete payment asks about.
  link: LinkedRow | null
}

// Spec §7 Months > To-do: alerts first, then each row a person can act on, with Record, Link, Skip, Unlink and Delete payment.
export function Todo({ snapshot, walk, month, showMonth, showChart }: TodoProps) {
  const breakeven = useBreakeven()
  const shown = useMemo<{ model: TodoModel } | { failed: string } | null>(() => {
    if (!breakeven.ready) return null
    const found = breakeven.value
    if (found instanceof Error) return { failed: found.message }
    if (found !== null && !found.ok) return { failed: found.errors.map((e) => e.message).join(' ') }
    return { model: todoModel({ snapshot, walk, breakeven: found, month }) }
  }, [snapshot, walk, breakeven, month])
  // The last figures stay up while a save reloads the household.
  const last = useRef(shown)
  if (shown) last.current = shown
  const ready = shown ?? last.current
  const { refetch } = useSnapshot()
  const router = useRouter()
  const edit = useEdit()
  const [sheet, setSheet] = useState<Open | null>(null)
  const [open, setOpen] = useState(false)
  // A save made from a row's own button that failed, shown under that row.
  const [inlineFailure, setInlineFailure] = useState<{ row: string; error: unknown } | null>(null)
  const { writable } = useSnapshot()
  if (!ready) return <Text tone="text2">Loading…</Text>
  if ('failed' in ready) return <Banner tone="negative" title="Could not work out the projection" body={ready.failed} action={{ label: 'Retry', icon: 'rotate-cw', onPress: refetch }} />
  const m = ready.model
  const go = (link: TodayLink) => router.push(link)
  const show = (row: ItemRow, step: Step = 'actions') => {
    edit.reset()
    setSheet({ row, step, link: null })
    setOpen(true)
  }
  const primary = (row: ItemRow) => {
    if (row.primary === 'record' && row.record) go(row.record)
    else if (row.primary === 'link') show(row, 'link')
    else if (row.primary === 'skip' && row.skip) {
      setInlineFailure(null)
      edit.mutate(row.skip.edit, { onError: (error) => setInlineFailure({ row: row.id, error }) })
    }
  }
  const undo = (row: ItemRow) => {
    if (!row.unskip) return
    setInlineFailure(null)
    edit.mutate(row.unskip.edit, { onError: (error) => setInlineFailure({ row: row.id, error }) })
  }
  const openAlert = (a: TodoAlert) => {
    const target = a.open
    if (target.kind === 'link') {
      const link = target.link
      return link.pathname === '/months' && link.params.view === 'chart' ? showChart(link.params.month) : go(link)
    }
    const row = m.groups.flatMap((g) => g.rows).find((r): r is ItemRow => r.type === 'item' && r.id === target.row_id)
    if (row) show(row, row.primary === 'link' ? 'link' : 'actions')
  }
  // A row that changed after the sheet opened shows its new state; one that is gone keeps the last one until the sheet closes.
  const live = sheet ? (m.groups.flatMap((g) => g.rows).find((r): r is ItemRow => r.type === 'item' && r.id === sheet.row.id) ?? sheet.row) : null
  return (
    <View style={{ gap: SPACE[6] }}>
      {m.alerts.length > 0 ? (
        <View style={{ gap: SPACE[2] }}>
          <Heading title="Alerts" />
          <Card flush>
            {m.alerts.map((a, i) => (
              <AlertRow
                key={a.alert.id}
                tone={a.tone}
                title={a.alert.title}
                body={<CopyText copy={a.alert.body} variant="footnote" tone="text2" />}
                onPress={() => openAlert(a)}
                divider={i > 0}
                action={SHORT_KINDS.has(a.alert.kind) ? { label: 'Compare a change', accessibilityLabel: `Compare a change, ${a.alert.title}`, onPress: () => router.push('/plan/compare') } : null}
              />
            ))}
          </Card>
        </View>
      ) : null}
      {m.groups.map((g) => (
        <View key={g.section} style={{ gap: SPACE[2] }}>
          <Heading title={SECTION_TITLES[g.section]} note={g.open > 0 ? `${g.open} to settle` : 'All settled'} />
          <Card flush>
            {g.rows.map((r, i) =>
              r.type === 'card' ? (
                <CardLine key={r.id} row={r} divider={i > 0} go={go} />
              ) : r.type === 'top_up' ? (
                <TopUpLine key={r.id} row={r} divider={i > 0} go={go} />
              ) : (
                <ItemLine
                  key={r.id}
                  row={r}
                  divider={i > 0}
                  onOpen={() => show(r)}
                  onPrimary={() => primary(r)}
                  onUndo={() => undo(r)}
                  busy={edit.isPending && edit.variables === r.skip?.edit}
                  undoing={edit.isPending && edit.variables === r.unskip?.edit}
                  writable={writable}
                  failure={inlineFailure?.row === r.id ? inlineFailure.error : null}
                />
              ),
            )}
          </Card>
        </View>
      ))}
      {m.empty ? <Empty month={month} trackedFrom={m.empty.tracked_from} showMonth={showMonth} go={go} /> : null}
      <ItemSheet
        open={open}
        target={sheet && live ? { ...sheet, row: live } : null}
        onStep={(step, link = null) => {
          edit.reset()
          setSheet((s) => (s ? { ...s, step, link } : s))
        }}
        onClose={() => setOpen(false)}
        edit={edit}
        snapshot={snapshot}
        go={go}
      />
    </View>
  )
}

function Heading({ title, note }: { title: string; note?: string }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: SPACE[3] }}>
      <Text variant="headline" level={3}>
        {title}
      </Text>
      {note ? (
        <Text variant="footnote" tone="text2">
          {note}
        </Text>
      ) : null}
    </View>
  )
}

function Failure({ error }: { error: unknown }) {
  const e = asDataError(error)
  return <Banner tone="negative" title={ERROR_TITLES[e.kind]} body={e.message} detail={e.technical ?? undefined} />
}

function Empty({ month, trackedFrom, showMonth, go }: { month: string; trackedFrom: string | null; showMonth: (month: string) => void; go: (link: TodayLink) => void }) {
  const locale = useLocale()
  const title = `Nothing to settle in ${monthTitle(month, locale)}`
  return (
    <Card>
      {trackedFrom ? (
        <EmptyState title={title} body={`Waypoint checks your plan from ${monthTitle(trackedFrom, locale)}, so earlier months have nothing to settle.`} action={{ label: `Show ${monthTitle(trackedFrom, locale)}`, onPress: () => showMonth(trackedFrom) }} />
      ) : (
        <EmptyState title={title} body="Bills, income, transfers and budgets from your plan show here each month, with every card’s payment." action={{ label: 'Add an item', onPress: () => go(PLAN_EDITOR) }} />
      )}
    </Card>
  )
}

const Divider = () => {
  const { colors } = useTheme()
  return <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} />
}

// The part of a row that opens its details: the whole text column, with the row's hover fill.
function Opener({ onPress, children }: { onPress: () => void; children: ReactNode }) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const hover = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { backgroundColor: colors.surface2 } : null)
  return (
    <Pressable role="button" onPress={onPress} onFocus={onFocus} onBlur={onBlur} style={(s) => [{ flex: 1, minWidth: 0, gap: SPACE[1], marginVertical: -SPACE[1], paddingVertical: SPACE[1], marginLeft: -SPACE[2], paddingLeft: SPACE[2], borderRadius: 8 }, hover(s), ring]}>
      {children}
    </Pressable>
  )
}

const LINE: ViewStyle = { minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[3], flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3] }
// The amount and the row's one action keep their width; the label beside them wraps and is never cut (invariant 186).
const TRAILING: ViewStyle = { flexShrink: 0, maxWidth: '50%', alignItems: 'flex-end', gap: SPACE[1] }
// A plain action under the amount: its padding is pulled back so its word ends at the row's edge, and its height into the row's padding.
const ACTION: ViewStyle = { marginRight: -SPACE[3], marginVertical: -SPACE[2] }

// The alerts about a month that runs short, which a change to the plan can fix.
const SHORT_KINDS = new Set(['below_floor', 'unfixable_gap', 'rate_independent', 'below_target'])

// A row's key amount, at the weight Today and Debts give theirs.
const KEY = { fontWeight: '600' } as const

const PRIMARY_LABEL = { record: 'Record', link: 'Link' } as const
const VERB = { bills: 'Paid', income: 'Received', transfers: 'Sent', budgets: 'Spent' } as const

// Done and healthy words read quietly; status colour is kept for what needs attention.
function Word({ w }: { w: RowWord }) {
  const words = useCopyWords()
  const text = w.on ? `${w.text} ${words({ date: w.on })}` : w.text
  if (w.tone === 'positive') return <QuietStatus variant="footnote">{text}</QuietStatus>
  return w.tone ? (
    <Pill tone={w.tone}>{text}</Pill>
  ) : (
    <Text variant="footnote" tone="text2">
      {text}
    </Text>
  )
}

function Words({ words }: { words: readonly RowWord[] }) {
  if (words.length === 0) return null
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[3], rowGap: SPACE[1] }}>
      {words.map((w) => (
        <Word key={w.text} w={w} />
      ))}
    </View>
  )
}

// A finished row says so beside its amount; an open one keeps its words under the label, with its button below.
const split = (row: { done: boolean; words: readonly RowWord[] }): { state: RowWord | null; rest: readonly RowWord[] } => (row.done ? { state: row.words[0] ?? null, rest: row.words.slice(1) } : { state: null, rest: row.words })

// One payment equal to the plan reads in the date line; anything else gets its own line.
const paidInFull = (row: ItemRow) => row.done && row.links.length === 1 && row.linked_minor === row.amount_minor

// When and where: 'Due 10 Oct · Pesos', 'Expected 28 Oct · Main', 'Paid 1 Oct · Main', or a budget's account.
function dateLine(row: ItemRow, words: ReturnType<typeof useCopyWords>): string {
  const where = row.to_account_id ? `${words({ account: row.account_id })} → ${words({ account: row.to_account_id })}` : words({ account: row.account_id })
  if (row.section === 'budgets') return where
  const link = row.links[0]
  if (paidInFull(row) && link) return `${VERB[row.section]} ${words({ date: link.posted_on })} · ${where}`
  const lead = row.done ? '' : row.section === 'income' ? 'Expected ' : 'Due '
  return `${lead}${words({ date: row.date })} · ${where}`
}

// What the row has moved so far, when it is not one payment of the planned amount: in and left, a different amount, or several parts.
function Progress({ row }: { row: ItemRow }) {
  const words = useCopyWords()
  const money = (minor: number, currency = row.currency) => <Money minor={minor} currency={currency} variant="footnote" tone="text2" />
  const budget = row.budget
  // No-break spaces keep each amount with its words when the line wraps.
  if (budget)
    return (
      <Text variant="footnote" tone="text2">
        {money(budget.spent_minor, budget.currency)}
        {' of '}
        {money(budget.budget_minor, budget.currency)}
        {'\u00a0spent'}
      </Text>
    )
  if (row.links.length === 0 || paidInFull(row)) return null
  const lastDay = row.links.at(-1)?.posted_on ?? row.date
  return (
    <Text variant="footnote" tone="text2">
      {`${VERB[row.section]}\u00a0`}
      {money(row.linked_minor)}
      {!row.done && row.open_minor > 0 ? (
        <>
          {' · '}
          {money(row.open_minor)}
          {'\u00a0left'}
        </>
      ) : row.links.length > 1 ? (
        ` in ${row.links.length} parts`
      ) : (
        ` on ${words({ date: lastDay })}`
      )}
    </Text>
  )
}

interface ItemLineProps {
  row: ItemRow
  divider: boolean
  onOpen: () => void
  onPrimary: () => void
  onUndo: () => void
  busy: boolean
  undoing: boolean
  // Skip, Done and Undo save at once, so they rest while saving is off; the row's sheet says why.
  writable: boolean
  // Why the row's own save failed, under the row the person tapped.
  failure: unknown
}

function ItemLine({ row, divider, onOpen, onPrimary, onUndo, busy, undoing, writable, failure }: ItemLineProps) {
  const words = useCopyWords()
  const locale = useLocale()
  const [confirming, setConfirming] = useState(false)
  const name = words({ item: row.plan_item_id })
  const budget = row.budget
  // A budget's action is short on the row; its whole name is read.
  const label = row.primary === 'skip' ? (row.section === 'budgets' ? 'Done' : (row.skip?.label ?? 'Skip')) : row.primary ? PRIMARY_LABEL[row.primary] : null
  const spoken = row.primary === 'skip' ? (row.skip?.label ?? 'Skip') : label
  const left = budget ? Math.max(0, budget.budget_minor - budget.spent_minor) : 0
  // Done drops what is left of a budget from the projection, so it asks first while anything is left.
  const press = () => (row.section === 'budgets' && row.primary === 'skip' && left > 0 ? setConfirming(true) : onPrimary())
  const { state, rest } = split(row)
  return (
    <View>
      <View style={LINE}>
        {divider ? <Divider /> : null}
        <Opener onPress={onOpen}>
          <Text variant="headline">{name}</Text>
          <Text variant="footnote" tone="text2">
            {dateLine(row, words)}
          </Text>
          <Progress row={row} />
          <Words words={rest} />
        </Opener>
        <View style={TRAILING}>
          {/* A budget shows what it allows this month, credits taken off, as its line under the name does. */}
          {budget ? <Money minor={budget.budget_minor} currency={budget.currency} style={KEY} /> : <Money minor={row.amount_minor} currency={row.currency} style={KEY} />}
          {state ? <Word w={state} /> : null}
          {label && !confirming ? (
            <View style={ACTION}>
              <Button label={busy ? 'Saving…' : label} accessibilityLabel={busy ? undefined : `${spoken} ${name}, ${words({ date: row.date })}`} variant="plain" size="small" disabled={busy || (row.primary === 'skip' && !writable)} onPress={press} />
            </View>
          ) : null}
          {row.unskip ? (
            <View style={ACTION}>
              <Button label={undoing ? 'Saving…' : 'Undo'} accessibilityLabel={undoing ? undefined : `${row.unskip.label}, ${name}`} variant="plain" size="small" disabled={undoing || !writable} onPress={onUndo} />
            </View>
          ) : null}
        </View>
      </View>
      {failure ? (
        <View style={{ paddingHorizontal: GUTTER, paddingBottom: SPACE[3] }}>
          <Failure error={failure} />
        </View>
      ) : null}
      {confirming && budget ? (
        <ConfirmDone
          left={left}
          currency={budget.currency}
          month={monthTitle(row.period.slice(0, 7), locale)}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            onPrimary()
          }}
        />
      ) : null}
    </View>
  )
}

// Done for this month, asked once in the row: what stops counting and what it does to the month.
function ConfirmDone({ left, currency, month, onCancel, onConfirm }: { left: number; currency: string; month: string; onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<View>(null)
  // Focus lands on Cancel, so Return never drops a budget by accident.
  useFocusOnMount(cancel)
  return (
    <View role="group" aria-label={DONE_FOR_MONTH} style={{ paddingHorizontal: GUTTER, paddingBottom: SPACE[3], gap: SPACE[2] }}>
      <Text variant="subhead">
        {'Stop counting the '}
        <Money minor={left} currency={currency} variant="subhead" />
        {` left in ${month}? That month ends higher by the same amount.`}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: SPACE[2] }}>
        <Button ref={cancel} label="Cancel" size="small" onPress={onCancel} />
        <Button label="Stop counting" variant="primary" size="small" onPress={onConfirm} />
      </View>
    </View>
  )
}

function CardLine({ row, divider, go }: { row: CardRow; divider: boolean; go: (link: TodayLink) => void }) {
  const words = useCopyWords()
  const primary = row.primary
  const { state, rest } = split(row)
  return (
    <View style={LINE}>
      {divider ? <Divider /> : null}
      <Opener onPress={() => go(row.detail_link)}>
        <Text variant="headline">{words({ account: row.account_id })}</Text>
        <CopyText copy={row.detail} variant="footnote" tone="text2" />
        {row.notes.map((note, i) => (
          <CopyText key={i} copy={note} variant="footnote" tone="text2" />
        ))}
        {row.warnings.map((w) => (
          <Pill key={w} tone="caution">
            {w}
          </Pill>
        ))}
        <Words words={rest} />
      </Opener>
      <View style={TRAILING}>
        {row.left_minor !== null && row.left_minor > 0 ? <Money minor={row.left_minor} currency={row.currency} style={KEY} /> : null}
        {state ? <Word w={state} /> : null}
        {/* Record payment is tonal, as on Debts: every action but the hero's is. */}
        {primary ? <Button label={primary.label} accessibilityLabel={`${primary.label} ${words({ account: row.account_id })}`} variant="tonal" size="small" onPress={() => go(primary.link)} /> : null}
      </View>
    </View>
  )
}

// A top-up has no sheet: it is not a plan item, so its one action records the transfer, as Today's does.
function TopUpLine({ row, divider, go }: { row: TopUpRow; divider: boolean; go: (link: TodayLink) => void }) {
  const words = useCopyWords()
  const name = row.title.map((p) => ('money' in p ? '' : words(p))).join('')
  const landed = row.landed
  return (
    <View style={LINE}>
      {divider ? <Divider /> : null}
      <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
        <CopyText copy={row.title} variant="headline" />
        <CopyText copy={row.detail} variant="footnote" tone="text2" />
        <Words words={row.words} />
      </View>
      <View style={TRAILING}>
        <Money minor={row.sent_minor} currency={row.currency} style={KEY} />
        {landed ? (
          <Text variant="footnote" tone="text2">
            {'→\u00a0'}
            <Money minor={landed.minor} currency={landed.currency} variant="footnote" tone="text2" />
          </Text>
        ) : null}
        <View style={ACTION}>
          <Button label={row.primary.label} accessibilityLabel={`${row.primary.label}, ${name}, ${words({ date: row.date })}`} variant="plain" size="small" onPress={() => go(row.primary.link)} />
        </View>
      </View>
    </View>
  )
}

interface SheetProps {
  open: boolean
  target: Open | null
  onStep: (step: Step, link?: LinkedRow | null) => void
  onClose: () => void
  edit: ReturnType<typeof useEdit>
  snapshot: Snapshot
  go: (link: TodayLink) => void
}

// One row's sheet: its figures and links, every mark it can take, Link's picker and the Delete payment check.
function ItemSheet({ open, target, onStep, onClose, edit, snapshot, go }: SheetProps) {
  const words = useCopyWords()
  // Kept while the sheet animates out.
  const shown = useRef(target)
  if (target) shown.current = target
  const t = target ?? shown.current
  const send = (change: Edit) => edit.mutate(change, { onSuccess: onClose })
  return (
    <Sheet open={open} onClose={onClose} title={t ? words({ item: t.row.plan_item_id }) : ''}>
      {t ? <SheetBody t={t} onStep={onStep} send={send} edit={edit} snapshot={snapshot} go={go} onClose={onClose} /> : null}
    </Sheet>
  )
}

function SheetBody({ t, onStep, send, edit, snapshot, go, onClose }: { t: Open; send: (change: Edit) => void } & Omit<SheetProps, 'open' | 'target'>) {
  const words = useCopyWords()
  const { writable, source, offline } = useSnapshot()
  const row = t.row
  const busy = edit.isPending
  // 'Saving…' shows on the button pressed; the others wait, disabled.
  const sending = (change: Edit) => busy && edit.variables === change
  const off = writable ? null : source.kind === 'sample' ? 'Samples are read-only. Sign in to settle your own months.' : offline ? 'Waypoint is offline. Saving comes back once it reaches the server.' : 'Your household is still loading.'
  const notice = (
    <>
      {edit.error ? <Failure error={edit.error} /> : null}
      {off ? <Banner tone="neutral" title="Saving is off" body={off} /> : null}
    </>
  )
  const record = row.record
  // The Add sheet opens over the tabs, so this one closes first.
  const onRecord = record
    ? () => {
        onClose()
        go(record)
      }
    : null
  if (t.step === 'link') return <LinkStep row={row} snapshot={snapshot} notice={notice} busy={busy || !writable} send={send} onBack={() => onStep('actions')} onRecord={onRecord} />
  if (t.step === 'confirm' && t.link) return <ConfirmDelete row={row} link={t.link} notice={notice} pending={busy} disabled={busy || !writable} send={send} onCancel={() => onStep('actions')} />
  return (
    <View style={{ gap: SPACE[4] }}>
      {notice}
      <View style={{ gap: SPACE[1] }}>
        <Money minor={row.amount_minor} currency={row.currency} variant="headline" />
        <Text variant="subhead" tone="text2">
          {dateLine(row, words)}
        </Text>
        <Progress row={row} />
        <Words words={row.words} />
      </View>
      {row.links.length > 0 ? (
        <View style={{ gap: SPACE[2] }}>
          <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
            {row.links.length === 1 ? 'Linked transaction' : 'Linked transactions'}
          </Text>
          <Card flush>
            {row.links.map((l, i) => (
              <View key={l.row_id} style={{ paddingHorizontal: GUTTER, paddingVertical: SPACE[3], gap: SPACE[2] }}>
                {i > 0 ? <Divider /> : null}
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3] }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text>{words({ text: l.description || 'Transaction' })}</Text>
                    <Text variant="footnote" tone="text2">
                      {`${words({ date: l.posted_on })} · ${words({ account: l.account_id })}${l.partner_account_id ? ` → ${words({ account: l.partner_account_id })}` : ''}`}
                    </Text>
                  </View>
                  <Money minor={l.amount_minor} currency={l.currency} />
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
                  <Button label={sending(l.unlink) ? 'Saving…' : 'Unlink'} accessibilityLabel={`Unlink the transaction of ${words({ date: l.posted_on })}`} size="small" disabled={busy || !writable} onPress={() => send(l.unlink)} />
                  <Button label="Delete payment" accessibilityLabel={`Delete payment of ${words({ date: l.posted_on })}`} size="small" variant="plain" disabled={busy || !writable} onPress={() => onStep('confirm', l)} />
                </View>
              </View>
            ))}
          </Card>
        </View>
      ) : null}
      <View style={{ gap: SPACE[2] }}>
        {onRecord ? <Button label="Record" variant="primary" onPress={onRecord} /> : null}
        {row.can_link ? <Button label="Link a transaction" onPress={() => onStep('link')} /> : null}
        {row.skip ? <Button label={sending(row.skip.edit) ? 'Saving…' : row.skip.label} disabled={busy || !writable} onPress={() => send((row.skip as NonNullable<ItemRow['skip']>).edit)} /> : null}
        {row.unskip ? <Button label={sending(row.unskip.edit) ? 'Saving…' : row.unskip.label} disabled={busy || !writable} onPress={() => send((row.unskip as NonNullable<ItemRow['unskip']>).edit)} /> : null}
        {!onRecord && !row.can_link && !row.skip && !row.unskip && row.links.length === 0 ? <Button label="Close" onPress={onClose} /> : null}
      </View>
    </View>
  )
}

const KIND_WORDS = { income: 'Income', expense: 'Expense', refund: 'Refund', transfer: 'Transfer', drawdown: 'Drawdown', adjustment: 'Adjustment' } as const

function LinkStep({ row, snapshot, notice, busy, send, onBack, onRecord }: { row: ItemRow; snapshot: Snapshot; notice: ReactNode; busy: boolean; send: (change: Edit) => void; onBack: () => void; onRecord: (() => void) | null }) {
  const words = useCopyWords()
  const locale = useLocale()
  const choices = useMemo(() => linkChoices(snapshot, row.id), [snapshot, row.id])
  const month = monthTitle(row.period.slice(0, 7), locale)
  // Late income may have come in a later month, so its picker reaches to this one.
  const when = row.carried_to ? `since ${month}` : `in ${month}`
  const account = words({ account: row.account_id })
  const list = (title: string, items: typeof choices) =>
    items.length === 0 ? null : (
      <View style={{ gap: SPACE[2] }}>
        <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
          {title}
        </Text>
        <Card flush>
          {items.map((c, i) => (
            <Row
              key={c.row_id}
              divider={i > 0}
              title={words({ text: c.description || KIND_WORDS[c.kind] })}
              detail={`${shortDay(c.posted_on, locale)} · ${words({ account: c.account_id })}${c.partner_account_id ? ` → ${words({ account: c.partner_account_id })}` : ''}`}
              trailing={<Money minor={c.amount_minor} currency={c.currency} />}
              onPress={() => (busy ? undefined : send(c.edit))}
            />
          ))}
        </Card>
      </View>
    )
  return (
    <View style={{ gap: SPACE[4] }}>
      {notice}
      {choices.length > 0 ? <Text tone="text2">{`Pick the transaction on ${account} that settles this for ${month}. Any amount links; what is left stays open.`}</Text> : null}
      {list('Possible matches', choices.filter((c) => c.suggested))}
      {list(`Unlinked ${when}`, choices.filter((c) => !c.suggested))}
      {choices.length === 0 ? (
        <View style={{ gap: SPACE[2] }}>
          <Text variant="headline">Nothing to link</Text>
          <Text tone="text2">{`${account} has no unlinked transaction ${when} that can settle this. Record it to add one.`}</Text>
          {onRecord ? <Button label="Record" variant="primary" onPress={onRecord} /> : null}
        </View>
      ) : null}
      <Button label="Back" variant="plain" icon="chevron-left" onPress={onBack} />
    </View>
  )
}

function ConfirmDelete({ row, link, notice, pending, disabled, send, onCancel }: { row: ItemRow; link: LinkedRow; notice: ReactNode; pending: boolean; disabled: boolean; send: (change: Edit) => void; onCancel: () => void }) {
  const words = useCopyWords()
  const cancel = useRef<View>(null)
  // Focus lands on Cancel, so Return never deletes by accident.
  useFocusOnMount(cancel)
  const legs = link.partner_account_id ? ` and its other leg on ${words({ account: link.partner_account_id })}` : ''
  return (
    <View style={{ gap: SPACE[4] }}>
      {notice}
      <Text variant="headline">Delete this payment?</Text>
      <Text tone="text2">
        {'This deletes '}
        <Money minor={link.amount_minor} currency={link.currency} tone="text2" />
        {` on ${words({ date: link.posted_on })} from ${words({ account: link.account_id })}${legs}. ${words({ item: row.plan_item_id })} no longer counts it.`}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2], justifyContent: 'flex-end' }}>
        <Button ref={cancel} label="Cancel" onPress={onCancel} />
        <Button label={pending ? 'Deleting…' : 'Delete payment'} variant="primary" disabled={disabled} onPress={() => send(link.remove)} />
      </View>
    </View>
  )
}
