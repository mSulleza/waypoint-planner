import { ledgerTotals, type Account, type Snapshot } from '@waypoint/core'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, View, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { useLedgerMonth, useSnapshot } from '@/data/hooks'
import { lastSave } from '@/data/last-save'
import { useDataSource } from '@/data/source'
import { shortDay } from '@/data/status'
import { useEdit } from '@/data/useEdit'
import { Missing } from '@/shell/Missing'
import { Screen } from '@/shell/Screen'
import { monthTitle, stepMonth } from '@/shell/url.model'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { EmptyState } from '@/ui/EmptyState'
import { Money } from '@/ui/Money'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { DateField } from '@/ui/DateField'
import { TextField } from '@/ui/TextField'
import { useFocusOnMount, useFocusRing, useLocale, useTheme } from '@/ui/theme'
import { useMaskText } from '@/ui/useMaskText'
import { GUTTER, LINE_WIDTH, RADII, ROW_MIN_HEIGHT, SPACE } from '@/ui/tokens'
import {
  deleteEdit,
  editDraft,
  editTarget,
  ledgerBounds,
  ledgerDayTitle,
  ledgerItems,
  ledgerMonthOf,
  lineOf,
  readEdit,
  savedMonth,
  type EditDraft,
  type EditField,
  type EditTarget,
  type LedgerItem,
  type LedgerLine,
} from './ledger.model'

const NOTE_MAX = 140

// Spec §7 Money: one account's month with the balance after every row, newest first; a row opens its edit sheet, and Reconcile compares the balance with the bank's.
export function Ledger({ accountId }: { accountId: string }) {
  const { snapshot } = useSnapshot()
  const account = snapshot?.doc.accounts.find((a) => a.id === accountId)
  if (!snapshot) return <Screen title={account?.name ?? 'Account'} kind="page" />
  if (!account) {
    return (
      <Screen title="Account" kind="page">
        <Missing what="account" list="/money" listTitle="Money" />
      </Screen>
    )
  }
  return <AccountLedger snapshot={snapshot} account={account} />
}

function AccountLedger({ snapshot, account }: { snapshot: Snapshot; account: Account }) {
  const router = useRouter()
  const locale = useLocale()
  const params = useLocalSearchParams<{ month?: string }>()
  const bounds = useMemo(() => ledgerBounds(snapshot, account), [snapshot, account])
  const month = ledgerMonthOf(params.month, bounds, snapshot.as_of)
  const ledger = useLedgerMonth(account.id, month)
  const items = useMemo(() => (ledger.state === 'ready' ? ledgerItems(snapshot, ledger.rows) : []), [snapshot, ledger])
  const debt = account.kind !== 'cash'
  const [editing, setEditing] = useState<{ id: string; opening: number } | null>(null)
  const [open, setOpen] = useState(false)

  // Each month is its own history entry, so Back steps back through the months seen.
  const step = (to: string) => router.push({ pathname: '/money/[accountId]', params: { accountId: account.id, month: to } })
  // After a save, the month the saved row sits in (invariant 191); the person did not pick it, so it replaces this entry.
  const jump = useCallback((to: string) => (to !== month ? router.setParams({ month: to }) : undefined), [router, month])

  // A save made elsewhere (the Add sheet, Reconcile) that wrote a row here shows that row's month on return.
  const seen = useRef(lastSave().seq)
  useFocusEffect(
    useCallback(() => {
      const last = lastSave()
      if (last.seq === seen.current) return
      seen.current = last.seq
      const to = savedMonth(last.rows, account.id)
      if (to) jump(to)
    }, [account.id, jump]),
  )

  const openRow = useCallback((id: string) => {
    setEditing((e) => ({ id, opening: (e?.opening ?? 0) + 1 }))
    setOpen(true)
  }, [])
  // Stable, so opening or closing the sheet redraws none of the rows.
  const render = useCallback((item: LedgerItem) => <LedgerCell item={item} asOf={snapshot.as_of} currency={account.currency} debt={debt} onOpen={openRow} />, [snapshot.as_of, account.currency, debt, openRow])
  return (
    <Screen title={account.name} kind="page" accountId={account.id} list={{ data: items, keyOf: (item) => item.key, render }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[1] }}>
        <Text variant="title2" level={2} style={{ flex: 1 }}>
          {monthTitle(month, locale)}
        </Text>
        <Button label="Previous month" icon="chevron-left" iconOnly variant="plain" disabled={month <= bounds.first} onPress={() => step(stepMonth(month, -1))} />
        <View style={{ marginRight: -SPACE[3] }}>
          <Button label="Next month" icon="chevron-right" iconOnly variant="plain" disabled={month >= bounds.last} onPress={() => step(stepMonth(month, 1))} />
        </View>
      </View>
      <Facts snapshot={snapshot} account={account} month={month} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[4], rowGap: SPACE[2] }}>
        <Button label="Reconcile" onPress={() => router.push({ pathname: '/reconcile', params: { account: account.id } })} />
        <Button label="Import CSV" onPress={() => router.push({ pathname: '/import', params: { account: account.id } })} />
        {items.length > 0 ? (
          <Text variant="footnote" tone="text2" style={{ flexShrink: 1 }}>
            {debt ? 'Under each amount is what is owed after it.' : 'Under each amount is the balance after it.'}
          </Text>
        ) : null}
      </View>
      {ledger.state === 'ready' && items.length === 0 ? (
        <Card>
          <EmptyState
            title={`Nothing recorded in ${monthTitle(month, locale)}`}
            body={`Transactions on ${account.name} dated in this month show here, with the balance after each one.`}
            action={{ label: 'Add a transaction', onPress: () => router.push({ pathname: '/add', params: { mode: 'out', from: account.id } }) }}
          />
        </Card>
      ) : null}
      <EditSheet snapshot={snapshot} editing={editing} open={open} onClose={() => setOpen(false)} jump={jump} />
    </Screen>
  )
}

function Facts({ snapshot, account, month }: { snapshot: Snapshot; account: Account; month: string }) {
  const t = useMemo(() => ledgerTotals(snapshot, account.id, month), [snapshot, account.id, month])
  const debt = account.kind !== 'cash'
  // A debt's balances read as what is owed; In and Out are what moved, both positive.
  const balance = (minor: number) => <Money minor={debt ? -minor : minor} currency={account.currency} owed={debt} variant="headline" />
  const facts: [string, ReactNode][] = [
    ['Opening', balance(t.opening_minor)],
    ['In', <Money key="in" minor={t.in_minor} currency={account.currency} variant="headline" />],
    ['Out', <Money key="out" minor={t.out_minor} currency={account.currency} variant="headline" />],
    ['Closing', balance(t.closing_minor)],
  ]
  return (
    // Two columns down to 320 px wide.
    <Card style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[4], rowGap: SPACE[3] }}>
      {facts.map(([label, figure]) => (
        <View key={label} style={{ flexGrow: 1, flexBasis: 100, gap: SPACE[1] }}>
          <Text variant="footnote" tone="text2">
            {label}
          </Text>
          {figure}
        </View>
      ))}
    </Card>
  )
}

interface CellProps {
  item: LedgerItem
  asOf: string
  currency: string
  debt: boolean
  onOpen: (rowId: string) => void
}

// One list item: a day heading or a row. Memoised, as the list redraws every cell whenever the screen redraws.
const LedgerCell = memo(function LedgerCell({ item, asOf, currency, debt, onOpen }: CellProps) {
  if (item.type === 'day') return <DayHeading day={item.day} asOf={asOf} top={item.top} />
  return <LineRow line={item.line} currency={currency} debt={debt} first={item.first} bottom={item.bottom} onPress={() => onOpen(item.line.id)} />
})

// The month's card edge for one list item: side lines always, the top line and corners on the first, the bottom on the last.
function useEdge(top: boolean, bottom: boolean): ViewStyle {
  const { colors } = useTheme()
  return {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderLeftWidth: LINE_WIDTH,
    borderRightWidth: LINE_WIDTH,
    borderTopWidth: top ? LINE_WIDTH : 0,
    borderBottomWidth: bottom ? LINE_WIDTH : 0,
    borderTopLeftRadius: top ? RADII.card : 0,
    borderTopRightRadius: top ? RADII.card : 0,
    borderBottomLeftRadius: bottom ? RADII.card : 0,
    borderBottomRightRadius: bottom ? RADII.card : 0,
  }
}

// A day's heading row inside the month's card, as Today's Next 30 days heads each day.
function DayHeading({ day, asOf, top }: { day: string; asOf: string; top: boolean }) {
  const locale = useLocale()
  const { colors } = useTheme()
  const edge = useEdge(top, false)
  return (
    <View style={[edge, { marginTop: top ? SPACE[2] : 0, paddingHorizontal: GUTTER, paddingTop: SPACE[3] }]}>
      {top ? null : <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} />}
      <Text variant="caption" tone="text3" level={3}>
        {ledgerDayTitle(day, asOf, locale)}
      </Text>
    </View>
  )
}

interface LineRowProps {
  line: LedgerLine
  currency: string
  debt: boolean
  // A day's first row sits under its heading with no line; the month's last row closes the card.
  first: boolean
  bottom: boolean
  onPress: () => void
}

function LineRow({ line, currency, debt, first, bottom, onPress }: LineRowProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const text = useMaskText()
  const edge = useEdge(false, bottom)
  const hover = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { backgroundColor: colors.surface2 } : null)
  return (
    <Pressable
      role="button"
      onPress={onPress}
      onFocus={onFocus}
      onBlur={onBlur}
      style={(s) => [edge, { minHeight: ROW_MIN_HEIGHT, paddingHorizontal: GUTTER, paddingVertical: SPACE[3], flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3] }, hover(s), ring && { ...ring, outlineOffset: -2 }]}
    >
      {first ? null : <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} />}
      <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
        <Text>{text(line.title)}</Text>
        {line.detail ? (
          <Text variant="footnote" tone="text2">
            {line.detail}
          </Text>
        ) : null}
      </View>
      <View style={{ flexShrink: 0, maxWidth: '50%', alignItems: 'flex-end', gap: SPACE[1] }}>
        <Money minor={line.amount_minor} currency={currency} signed />
        <Money minor={debt ? -line.balance_minor : line.balance_minor} currency={currency} owed={debt} variant="footnote" tone="text2" />
      </View>
    </Pressable>
  )
}

interface EditSheetProps {
  snapshot: Snapshot
  // The row, and a count of openings so each one starts from the saved values.
  editing: { id: string; opening: number } | null
  open: boolean
  onClose: () => void
  jump: (month: string) => void
}

// One row's sheet: its day, amount and note, saved to the row or to both transfer legs in one write, and Delete with a check first.
function EditSheet({ snapshot, editing, open, onClose, jump }: EditSheetProps) {
  // Kept while the sheet animates out, and after a delete has taken the row from the snapshot.
  const kept = useRef<EditTarget | null>(null)
  const rowId = editing?.id ?? null
  const found = useMemo(() => (rowId ? editTarget(snapshot, rowId) : null), [snapshot, rowId])
  if (found) kept.current = found
  const target = found ?? kept.current
  return (
    <Sheet open={open} onClose={onClose} title="Transaction">
      {target ? <EditBody key={`${target.row.id} ${editing?.opening ?? 0}`} snapshot={snapshot} target={target} gone={rowId !== null && !found} onClose={onClose} jump={jump} /> : null}
    </Sheet>
  )
}

function EditBody({ snapshot, target, gone, onClose, jump }: { snapshot: Snapshot; target: EditTarget; gone: boolean; onClose: () => void; jump: (month: string) => void }) {
  const locale = useLocale()
  const text = useMaskText()
  const { writable, source, offline } = useSnapshot()
  const { owner } = useDataSource()
  const edit = useEdit()
  const [draft, setDraft] = useState<EditDraft>(() => editDraft(target, locale))
  const [tried, setTried] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const day = (iso: string) => shortDay(iso, locale, true)
  const read = readEdit(target, draft, { locale, household_id: owner ?? '', day })
  const errors: Partial<Record<EditField, string>> = tried && !read.ok ? read.errors : {}
  const fresh = useMemo(() => lineOf(snapshot, { ...target.row, running_balance_minor: 0 }), [snapshot, target.row])
  // A row deleted elsewhere keeps the words it was opened with; read again, it would lose the transfer's other account.
  const kept = useRef(fresh)
  if (!gone) kept.current = fresh
  const line = kept.current
  const busy = edit.isPending
  // The row left the household on another device; our own delete is already closing the sheet.
  const deleted = gone && !busy && !edit.isSuccess
  const off = writable ? null : source.kind === 'sample' ? 'Samples are read-only. Sign in to edit your own transactions.' : offline ? 'Waypoint is offline. Saving comes back once it reaches the server.' : 'Your household is still loading.'
  const notice = deleted ? (
    <Banner tone="neutral" title="Deleted elsewhere" body="This transaction is no longer in your household, so there is nothing to save." />
  ) : (
    <>
      {edit.error ? <Failure error={edit.error} /> : null}
      {off ? <Banner tone="neutral" title="Saving is off" body={off} /> : null}
    </>
  )
  const locked = busy || !writable || deleted
  const change = (part: Partial<EditDraft>) => setDraft((d) => ({ ...d, ...part }))
  const save = () => {
    setTried(true)
    if (!read.ok) return
    if (read.edit === null) return onClose()
    const month = read.month
    edit.mutate(read.edit, {
      onSuccess: () => {
        onClose()
        jump(month)
      },
    })
  }
  if (confirm) return <ConfirmDelete target={target} notice={notice} pending={busy} disabled={locked} onCancel={() => setConfirm(false)} onDelete={() => edit.mutate(deleteEdit(target), { onSuccess: onClose })} />

  const { row, account, partner, partner_account: other, across } = target
  const [sentFrom, landedIn] = row.amount_minor < 0 ? [account, other] : [other, account]
  // A transfer's other leg moves with it, and the note says where to.
  const partnerNote = !deleted && partner && other && read.ok && read.partner_day && read.partner_day !== partner.posted_on ? `The leg on ${other.name} moves to ${shortDay(read.partner_day, locale)} too.` : null
  return (
    <View style={{ gap: SPACE[4] }}>
      {notice}
      <View style={{ gap: SPACE[1] }}>
        <Text variant="headline">{text(line.title)}</Text>
        {/* A transfer's detail names the other account; any other row says which account it is on. */}
        <Text variant="subhead" tone="text2">
          {partner ? line.detail : [line.detail, account.name].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <DateField
        label="Day"
        value={draft.day}
        onChange={(day) => change({ day })}
        error={errors.day ?? null}
        note={partnerNote ?? (read.ok || !read.errors.day ? ledgerDayTitle(draft.day, snapshot.as_of, locale) : null)}
      />
      <TextField
        label={across && sentFrom ? `Sent from ${sentFrom.name}` : 'Amount'}
        money={{ currency: (partner && sentFrom ? sentFrom : account).currency }}
        value={draft.amount}
        onChangeText={(amount) => change({ amount })}
        error={errors.amount ?? null}
        note={!deleted && partner && !across && other ? `Both legs change: out of ${sentFrom?.name ?? ''} and into ${landedIn?.name ?? ''}.` : null}
      />
      {across && landedIn ? <TextField label={`Received in ${landedIn.name}`} money={{ currency: landedIn.currency }} value={draft.received} onChangeText={(received) => change({ received })} error={errors.received ?? null} /> : null}
      <TextField label="Note" value={draft.note} onChangeText={(note) => change({ note })} maxLength={NOTE_MAX} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2], justifyContent: 'space-between' }}>
        <Button label="Delete" variant="plain" disabled={locked} onPress={() => setConfirm(true)} />
        <Button label={busy ? 'Saving…' : 'Save'} variant="primary" disabled={locked} onPress={save} />
      </View>
    </View>
  )
}

function Failure({ error }: { error: unknown }) {
  const e = asDataError(error)
  return <Banner tone="negative" title={ERROR_TITLES[e.kind]} body={e.message} detail={e.technical ?? undefined} />
}

function ConfirmDelete({ target, notice, pending, disabled, onCancel, onDelete }: { target: EditTarget; notice: ReactNode; pending: boolean; disabled: boolean; onCancel: () => void; onDelete: () => void }) {
  const locale = useLocale()
  const cancel = useRef<View>(null)
  // Focus lands on Cancel, so Return never deletes by accident.
  useFocusOnMount(cancel)
  const { row, account, partner_account: other } = target
  const legs = other ? ` and its other leg on ${other.name}` : ''
  return (
    <View style={{ gap: SPACE[4] }}>
      {notice}
      <Text variant="headline">Delete this transaction?</Text>
      <Text tone="text2">
        {'This deletes '}
        <Money minor={row.amount_minor} currency={account.currency} tone="text2" signed />
        {` on ${shortDay(row.posted_on, locale)} from ${account.name}${legs}.${target.linked_item ? ` ${target.linked_item} no longer counts it.` : ''}`}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2], justifyContent: 'flex-end' }}>
        <Button ref={cancel} label="Cancel" onPress={onCancel} />
        <Button label={pending ? 'Deleting…' : 'Delete'} variant="primary" disabled={disabled} onPress={onDelete} />
      </View>
    </View>
  )
}
