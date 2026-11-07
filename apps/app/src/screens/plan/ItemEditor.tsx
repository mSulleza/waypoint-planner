import { planItemRow, type Account, type PlanItem, type Snapshot } from '@waypoint/core'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { ITEM_VALUES, type Edit } from '@/data/edits'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { useSnapshot } from '@/data/hooks'
import { useDataSource } from '@/data/source'
import { useEdit } from '@/data/useEdit'
import { isDay } from '@/data/field-text'
import { randomId } from '@/data/uuid'
import { Missing } from '@/shell/Missing'
import { NEW_ITEM_ID, stepMonth } from '@/shell/url.model'
import { useBack } from '@/shell/useBack'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Choices, type Choice } from '@/ui/Choices'
import { Money } from '@/ui/Money'
import { MonthStepper } from '@/ui/MonthStepper'
import { Row } from '@/ui/Row'
import { Segmented } from '@/ui/Segmented'
import { Text } from '@/ui/Text'
import { DateField } from '@/ui/DateField'
import { FieldError, TextField } from '@/ui/TextField'
import { useFocusOnMount, useLocale } from '@/ui/theme'
import { SPACE } from '@/ui/tokens'
import { useZodForm } from '@/ui/useZodForm'
import {
  accountGroups,
  amountCurrency,
  categoryChoices,
  CONFIDENCE_WORDS,
  debtsPaidBy,
  defaultFromMonth,
  endPlan,
  EVERY_WORDS,
  everyChoices,
  FIELD_NAMES,
  fromMonths,
  INCOME_STOP_WORDS,
  itemProblem,
  KIND_ORDER,
  KIND_WORDS,
  linksOf,
  monthCount,
  monthName,
  moveFirstMonth,
  openItem,
  paidFrom,
  periodName,
  pickAccount,
  pickCategory,
  readItem,
  routeOf,
  ROLL_WORDS,
  ROUTE_ORDER,
  ROUTE_WORDS,
  routeErrors,
  savePlan,
  splitPlan,
  withKind,
  withRoute,
  type Field,
  type ItemDraft,
  type ItemKind,
  type Opened,
  type TransferRoute,
} from './item.model'
import { stepMonths, stepsOf } from './plan.model'

// The plan item editor (spec §7): /plan/item/<id> edits an item, /plan/item/new adds one; ?kind= and ?category= start a new one.
export function PlanItemEditor({ id }: { id: string }) {
  const params = useLocalSearchParams<{ kind?: string; category?: string }>()
  const { snapshot } = useSnapshot()
  const locale = useLocale()
  // Show the latest: the form opens again from what is saved now.
  const [round, setRound] = useState(0)
  // The first opening decides new, edit or missing; a reload after a write keeps the form, so a delete finishing here never flashes 'No such plan item'.
  const opened = useRef<Opened | null>(null)
  if (snapshot && opened.current === null) opened.current = openItem(snapshot, id, NEW_ITEM_ID, params, locale)
  const shown = opened.current
  if (!snapshot || !shown) return null
  if (shown.kind === 'missing') return <Missing what="plan item" list="/plan" listTitle="Plan" />
  const reload = () => {
    opened.current = openItem(snapshot, id, NEW_ITEM_ID, params, locale)
    setRound((r) => r + 1)
  }
  return <Form key={round} snapshot={snapshot} loaded={shown.kind === 'edit' ? shown.item : null} initial={shown.draft} reload={reload} />
}

interface FormProps {
  snapshot: Snapshot
  // The row as it was when the form opened: Save and End write only while the table still holds it.
  loaded: PlanItem | null
  initial: ItemDraft
  reload: () => void
}

type Action = 'save' | 'split' | 'end' | 'delete'

const Label = ({ children }: { children: string }) => (
  <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
    {children}
  </Text>
)

const Note = ({ children }: { children: ReactNode }) => (
  <Text variant="footnote" tone="text2">
    {children}
  </Text>
)

function Form({ snapshot, loaded, initial, reload }: FormProps) {
  const locale = useLocale()
  const { writable, source, offline } = useSnapshot()
  const { owner } = useDataSource()
  const edit = useEdit()
  // Made once per opening, so a retry after a lost reply saves the same row.
  const [id] = useState(() => loaded?.id ?? randomId())
  const [action, setAction] = useState<Action | null>(null)
  const [confirm, setConfirm] = useState<'delete' | 'linked' | null>(null)
  const endButton = useRef<View>(null)
  const read = useCallback((d: ItemDraft) => readItem(snapshot, d, { id, locale, loaded }), [snapshot, id, locale, loaded])
  const check = useCallback((row: PlanItem) => routeErrors(snapshot, row), [snapshot])
  const form = useZodForm<ItemDraft, PlanItem, Field>({ schema: planItemRow, initial, read, check, names: FIELD_NAMES })
  const { draft } = form
  const current = loaded ? snapshot.doc.plan_items.find((p) => p.id === loaded.id) : undefined
  const links = useMemo(() => (loaded ? linksOf(snapshot, loaded.id) : []), [snapshot, loaded])
  const range = useMemo(() => (loaded ? fromMonths(loaded, snapshot.as_of) : null), [loaded, snapshot.as_of])
  const steps = useMemo(() => (loaded ? stepsOf(snapshot.doc.plan_items, loaded.id) : null), [snapshot, loaded])
  const [month, setMonth] = useState(() => (range ? defaultFromMonth(range, snapshot.as_of) : ''))

  const busy = edit.isPending
  const done = edit.isSuccess
  // The item left the household on another device; our own delete is already leaving the page.
  const gone = loaded !== null && !current && !busy && !done
  const changed = loaded !== null && current !== undefined && current !== loaded && !busy && !done && ITEM_VALUES.some((c) => current[c] !== loaded[c])
  const locked = busy || done || !writable || gone
  const row = form.result.ok ? form.result.value : null
  const failure = edit.error ? asDataError(edit.error) : null
  const problem = failure && row ? itemProblem(failure, row, locale) : failure ? { field: null, text: failure.message } : null
  const errors = { ...form.errors, ...(problem?.field ? { [problem.field]: problem.text } : {}) } as Partial<Record<Field, string>>

  // Back to where the person came from, or to the list when a link opened the app here.
  const leave = useBack()
  const send = (which: Action, change: Edit) => {
    setAction(which)
    edit.mutate(change, { onSuccess: leave })
  }
  const change = (next: (d: ItemDraft) => ItemDraft) => {
    form.change(next)
    if (edit.error) edit.reset()
  }

  const save = loaded && row ? savePlan(snapshot, loaded, row, links, locale) : null
  const onSave = () => {
    const value = form.attempt()
    if (!value || locked) return
    if (!loaded) return send('save', { kind: 'add_item', row: { ...value, household_id: owner ?? '' } })
    if (!save?.ok) return
    if (save.value === null) return leave()
    send('save', save.value)
  }
  const split = loaded && row && range ? splitPlan(snapshot, loaded, row, links, month, locale) : null
  const onSplit = () => {
    const value = form.attempt()
    if (!value || locked || !loaded || !split?.ok) return
    send('split', { kind: 'split_item', id: loaded.id, from: split.value.from, patch: split.value.patch })
  }
  const end = loaded && range ? endPlan(loaded, links, month, range.max, locale) : null
  const onEnd = () => {
    if (locked || !end?.ok) return
    send('end', end.value)
  }
  const onDelete = () => {
    if (locked || !loaded) return
    send('delete', { kind: 'delete_item', id: loaded.id })
  }
  const askDelete = () => setConfirm(links.length > 0 ? 'linked' : 'delete')

  const offNote = !writable ? (source.kind === 'sample' ? 'Samples are read-only. Sign in to change your own plan.' : offline ? 'Offline: saving is off until Waypoint reaches the server again.' : 'Saving is off until your household loads.') : null
  // A delete refused because a payment was linked elsewhere in the meantime says so once, with End it instead.
  const linkedRefusal = failure?.code === 'linked' && action === 'delete'
  const banner = (which: Action) =>
    failure && action === which && !problem?.field && !linkedRefusal ? (
      <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={problem?.text} detail={failure.technical ?? undefined} action={failure.code === 'stale' ? { label: 'Show the latest', onPress: reload } : undefined} />
    ) : null

  const currency = amountCurrency(snapshot, draft)
  const isNew = loaded === null
  const repeats = draft.every !== 'once'
  const dirty = loaded !== null && row !== null && ITEM_VALUES.some((c) => row[c] !== loaded[c])
  const loadedCurrency = loaded ? amountCurrency(snapshot, { kind: loaded.kind, route: routeOf(loaded), from: loaded.from_account_id, to: loaded.to_account_id }) : null

  return (
    <View style={{ gap: SPACE[6] }}>
      {loaded && loadedCurrency ? <Intro loaded={loaded} links={links} currency={loadedCurrency} /> : null}
      {loaded && loadedCurrency && steps ? <Steps steps={steps} open={loaded.id} currency={loadedCurrency} /> : null}
      {gone ? <Banner tone="neutral" title="Deleted elsewhere" body="This plan item is no longer in your household, so there is nothing to save." /> : null}
      {changed ? <Banner tone="caution" title="Changed elsewhere" body="This item changed on another device after it opened here." action={{ label: 'Show the latest', onPress: reload }} /> : null}

      {isNew ? (
        <View style={{ gap: SPACE[2] }}>
          <Label>What is it?</Label>
          <Choices<ItemKind> label="What is it?" groups={[{ choices: KIND_ORDER.map((k) => ({ value: k, title: KIND_WORDS[k].title, detail: KIND_WORDS[k].detail })) }]} value={draft.kind} onChange={(k) => change((d) => withKind(snapshot, d, k))} />
        </View>
      ) : null}

      {draft.kind === 'transfer' ? (
        <View style={{ gap: SPACE[2] }}>
          <Label>Kind of transfer</Label>
          <Choices<TransferRoute> label="Kind of transfer" groups={[{ choices: ROUTE_ORDER.map((r) => ({ value: r, title: ROUTE_WORDS[r].title, detail: ROUTE_WORDS[r].detail })) }]} value={draft.route} onChange={(r) => change((d) => withRoute(snapshot, d, r))} />
        </View>
      ) : null}

      <TextField label="Name" value={draft.name} onChangeText={(name) => change((d) => ({ ...d, name, named: true }))} maxLength={60} error={errors.name ?? null} editable={!locked} autoCapitalize="sentences" />

      <Accounts snapshot={snapshot} draft={draft} errors={errors} change={change} />

      {draft.kind === 'allowance' ? <Category snapshot={snapshot} draft={draft} error={errors.category_id ?? null} change={change} /> : null}

      <TextField
        label={draft.kind === 'installment' ? 'Monthly amount' : 'Amount'}
        hint={draft.kind === 'installment' ? 'What the card bills each month.' : draft.kind === 'allowance' ? 'For the whole month. Below zero for a credit that lowers the budget.' : undefined}
        money={{ currency }}
        value={draft.amount}
        onChangeText={(amount) => change((d) => ({ ...d, amount }))}
        error={errors.amount_minor ?? null}
        editable={!locked}
        onSubmitEditing={onSave}
      />

      {draft.kind === 'installment' ? (
        <View style={{ gap: SPACE[4] }}>
          <MonthStepper label="First billed month" value={draft.first_month} onChange={(m) => change((d) => moveFirstMonth(d, m))} error={errors.starts_on ?? null} disabled={locked} />
          <MonthStepper
            label="Last billed month"
            value={draft.last_month}
            min={draft.first_month}
            onChange={(m) => change((d) => ({ ...d, last_month: m }))}
            error={errors.ends_on ?? null}
            note={`${monthCount(draft.first_month, draft.last_month)} months, ${monthName(draft.first_month, locale)} to ${monthName(draft.last_month, locale)}.`}
            disabled={locked}
          />
        </View>
      ) : (
        <Schedule draft={draft} errors={errors} change={change} allowedEvery={everyChoices(draft.kind, form.allowed('every') as readonly ItemDraft['every'][], loaded?.every ?? draft.every)} allowedRoll={form.allowed('roll') as readonly ItemDraft['roll'][]} locked={locked} />
      )}

      <View style={{ gap: SPACE[2] }}>
        <Label>How sure</Label>
        <Segmented<ItemDraft['confidence']>
          label="How sure"
          options={(form.allowed('confidence') as readonly ItemDraft['confidence'][]).map((c) => ({ value: c, label: CONFIDENCE_WORDS[c]?.title ?? c }))}
          value={draft.confidence}
          onChange={(confidence) => change((d) => ({ ...d, confidence }))}
        />
        <Note>{CONFIDENCE_WORDS[draft.confidence].note}</Note>
      </View>

      {draft.kind === 'bill' || draft.kind === 'allowance' ? (
        <View style={{ gap: SPACE[2] }}>
          <Label>If income stops</Label>
          <Segmented<keyof typeof INCOME_STOP_WORDS>
            label="If income stops"
            options={(['keeps', 'stops'] as const).map((s) => ({ value: s, label: INCOME_STOP_WORDS[s].title }))}
            value={draft.stops_with_income ? 'stops' : 'keeps'}
            onChange={(s) => change((d) => ({ ...d, stops_with_income: s === 'stops' }))}
          />
          <Note>{INCOME_STOP_WORDS[draft.stops_with_income ? 'stops' : 'keeps'].note}</Note>
        </View>
      ) : null}

      <View style={{ gap: SPACE[3] }}>
        {banner('save')}
        <View style={{ gap: SPACE[2] }}>
          <Button label={busy && action === 'save' ? 'Saving…' : isNew ? 'Add to plan' : 'Save'} variant="primary" onPress={onSave} disabled={locked || (save !== null && !save.ok)} />
          {offNote ? <Note>{offNote}</Note> : save && !save.ok ? <Note>{save.reason}</Note> : !form.result.ok && Object.keys(form.errors).length > 0 ? <Note>Correct the fields marked above.</Note> : loaded && repeats ? <Note>Save changes every month of it, earlier months too. To change only later months, use Change from below.</Note> : null}
        </View>
      </View>

      {loaded && range ? (
        <View style={{ gap: SPACE[4] }}>
          <View style={{ gap: SPACE[1] }}>
            <Text variant="title2" level={2}>
              From a month on
            </Text>
            <Note>Months before it stay as they are, with their payments.</Note>
          </View>
          <MonthStepper label="From" value={month} min={range.min} max={range.max} onChange={setMonth} disabled={locked} />
          {banner('split')}
          <View style={{ gap: SPACE[2] }}>
            <Button label={busy && action === 'split' ? 'Changing…' : `Change from ${monthName(month, locale)}`} variant={save && !save.ok && split?.ok ? 'primary' : 'tonal'} onPress={onSplit} disabled={locked || (split !== null && !split.ok)} />
            <Note>{!row ? 'Correct the fields above first.' : split && !split.ok ? split.reason : `Keeps ${monthName(month, locale)} and later as you set them above, and earlier months as saved.`}</Note>
          </View>
          {banner('end')}
          <View style={{ gap: SPACE[2] }}>
            <Button ref={endButton} label={busy && action === 'end' ? 'Ending…' : `End before ${monthName(month, locale)}`} onPress={onEnd} disabled={locked || !end?.ok} />
            <Note>{end && !end.ok ? end.reason : `${monthName(stepMonth(month, -1), locale)} is its last ${loaded.kind === 'installment' ? 'billed ' : ''}month.${dirty ? ' Only the end is saved, not the changes above.' : ''}`}</Note>
          </View>
        </View>
      ) : null}

      {loaded ? (
        <View style={{ gap: SPACE[3] }}>
          {banner('delete')}
          {confirm === 'linked' || linkedRefusal ? (
            <Banner
              tone="caution"
              title="Payments are linked to it"
              body="A plan item with linked payments stays, so the months it settled keep their record."
              action={end?.ok ? { label: 'End it instead', onPress: () => endButton.current?.focus() } : undefined}
            />
          ) : confirm === 'delete' ? (
            <ConfirmDelete name={loaded.name} busy={busy && action === 'delete'} disabled={locked} onCancel={() => setConfirm(null)} onDelete={onDelete} />
          ) : (
            <View style={{ flexDirection: 'row', marginLeft: -SPACE[3] }}>
              <Button label="Delete" variant="plain" size="small" onPress={askDelete} disabled={locked} />
            </View>
          )}
        </View>
      ) : null}
    </View>
  )
}

// What the item is and, with links, how many payments settle it.
function Intro({ loaded, links, currency }: { loaded: PlanItem; links: ReturnType<typeof linksOf>; currency: string }) {
  const locale = useLocale()
  const latest = links.at(-1)?.period
  return (
    <View style={{ gap: SPACE[1] }}>
      <Text variant="subhead" tone="text2">{`${KIND_WORDS[loaded.kind].title} · ${currency}`}</Text>
      {latest ? <Text variant="subhead" tone="text2">{`${links.length} ${links.length === 1 ? 'payment is' : 'payments are'} linked to it, the latest for ${periodName(loaded, latest, locale)}.`}</Text> : null}
    </View>
  )
}

// Every step of a stepped item, as Plan shows them in one row; each other step opens in its own editor.
function Steps({ steps, open, currency }: { steps: readonly PlanItem[]; open: string; currency: string }) {
  const router = useRouter()
  const locale = useLocale()
  return (
    <View style={{ gap: SPACE[2] }}>
      <Label>Steps</Label>
      <Card flush>
        {steps.map((s, i) => (
          <Row
            key={s.id}
            divider={i > 0}
            title={stepMonths(s, locale)}
            detail={s.id === open ? 'This step' : undefined}
            trailing={<Money minor={s.amount_minor} currency={currency} />}
            onPress={s.id === open ? undefined : () => router.push({ pathname: '/plan/item/[id]', params: { id: s.id } })}
          />
        ))}
      </Card>
      <Note>Plan shows these as one item. Each step keeps its own amount and dates.</Note>
    </View>
  )
}

const choiceOf = (a: Account): Choice<string> => ({ value: a.id, title: a.archived_at === null ? a.name : `${a.name} · Archived` })

interface FieldProps {
  snapshot: Snapshot
  draft: ItemDraft
  errors: Partial<Record<Field, string>>
  change: (next: (d: ItemDraft) => ItemDraft) => void
}

function AccountField({ label, snapshot, draft, side, error, change, empty }: { label: string; side: 'from' | 'to'; error: string | null; empty: string } & Omit<FieldProps, 'errors'>) {
  const groups = accountGroups(snapshot, draft, side)
  return (
    <View style={{ gap: SPACE[2] }}>
      <Label>{label}</Label>
      {groups.length === 0 ? (
        <Note>{empty}</Note>
      ) : (
        <Choices layout="chips" label={label} groups={[{ choices: groups.flatMap((g) => g.accounts.map(choiceOf)) }]} value={side === 'from' ? draft.from : draft.to} onChange={(id) => change((d) => pickAccount(snapshot, d, side, id))} />
      )}
      {error ? <FieldError text={error} /> : null}
    </View>
  )
}

// The accounts each kind uses (spec §4 plan_items); a transfer into a debt has no from field and says which account pays it.
function Accounts({ snapshot, draft, errors, change }: FieldProps) {
  const props = { snapshot, draft, change }
  const from = errors.from_account_id ?? null
  const to = errors.to_account_id ?? null
  const NO_CASH = 'No cash account yet. Add one in Settings.'
  switch (draft.kind) {
    case 'income': {
      const draw = snapshot.doc.accounts.find((a) => a.id === draft.to && a.kind !== 'cash')
      return (
        <View style={{ gap: SPACE[2] }}>
          <AccountField {...props} label="Lands in" side="to" error={to} empty={NO_CASH} />
          {draw && !to ? <Note>{`A planned draw: the money goes straight onto ${draw.name}, as a loan paid to a card does.`}</Note> : null}
        </View>
      )
    }
    case 'bill':
      return <AccountField {...props} label="Paid from" side="from" error={from} empty={NO_CASH} />
    case 'allowance':
      return <AccountField {...props} label="Spent from" side="from" error={from} empty={NO_CASH} />
    case 'installment':
      return <AccountField {...props} label="Card" side="from" error={from} empty="No card yet. Add one in Settings." />
    case 'transfer':
      if (draft.route === 'debt') return <DebtPayment {...props} error={to} />
      if (draft.route === 'extra') return <ExtraFrom {...props} error={from} />
      return (
        <View style={{ gap: SPACE[6] }}>
          <AccountField {...props} label="From" side="from" error={from} empty={NO_CASH} />
          <AccountField {...props} label="To" side="to" error={to} empty="No other cash account. Add one in Settings." />
        </View>
      )
  }
}

function DebtPayment({ snapshot, draft, change, error }: Omit<FieldProps, 'errors'> & { error: string | null }) {
  const payer = paidFrom(snapshot, draft.to)
  const debt = snapshot.doc.accounts.find((a) => a.id === draft.to)
  return (
    <View style={{ gap: SPACE[6] }}>
      <AccountField snapshot={snapshot} draft={draft} change={change} label="Into" side="to" error={error} empty="No card or loan yet. Add one in Settings." />
      {debt ? (
        <View style={{ gap: SPACE[1] }}>
          <Text>{payer ? `Paid from ${payer.name}` : 'Paid from no account yet'}</Text>
          <Note>{`It leaves the account set to pay ${debt.name} in Settings, and follows it when that changes.`}</Note>
        </View>
      ) : null}
    </View>
  )
}

function ExtraFrom({ snapshot, draft, change, error }: Omit<FieldProps, 'errors'> & { error: string | null }) {
  const debts = debtsPaidBy(snapshot, draft.from)
  const account = snapshot.doc.accounts.find((a) => a.id === draft.from)
  return (
    <View style={{ gap: SPACE[2] }}>
      <AccountField snapshot={snapshot} draft={draft} change={change} label="From" side="from" error={error} empty="No cash account yet. Add one in Settings." />
      {account && !error ? <Note>{debts.length > 0 ? `Shared in payoff order among the debts ${account.name} pays: ${debts.map((d) => d.name).join(', ')}.` : `${account.name} pays no debt yet, so this moves nothing until one is paid from it.`}</Note> : null}
    </View>
  )
}

function Category({ snapshot, draft, error, change }: Omit<FieldProps, 'errors'> & { error: string | null }) {
  const choices = categoryChoices(snapshot, draft.category)
  return (
    <View style={{ gap: SPACE[2] }}>
      <Label>Category</Label>
      {choices.length === 0 ? (
        <Note>No categories yet. Add one in Settings.</Note>
      ) : (
        <Choices layout="chips" label="Category" groups={[{ choices: choices.map((c) => ({ value: c.id, title: c.archived_at === null ? c.name : `${c.name} · Archived` })) }]} value={draft.category} onChange={(id) => change((d) => pickCategory(snapshot, d, id))} />
      )}
      {error ? <FieldError text={error} /> : null}
      <Note>Spending in this category counts against the budget, unless it is linked to another plan item.</Note>
    </View>
  )
}

interface ScheduleProps {
  draft: ItemDraft
  errors: Partial<Record<Field, string>>
  change: (next: (d: ItemDraft) => ItemDraft) => void
  allowedEvery: readonly ItemDraft['every'][]
  allowedRoll: readonly ItemDraft['roll'][]
  locked: boolean
}

// How often and from when; the weekend rule only where a date can land on one.
function Schedule({ draft, errors, change, allowedEvery, allowedRoll, locked }: ScheduleProps) {
  const locale = useLocale()
  const once = draft.every === 'once'
  const day = (iso: string) => (isDay(iso) ? new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)) : null)
  return (
    <View style={{ gap: SPACE[6] }}>
      <View style={{ gap: SPACE[2] }}>
        <Label>Repeats</Label>
        <Choices layout="chips" label="Repeats" groups={[{ choices: allowedEvery.map((e) => ({ value: e, title: EVERY_WORDS[e] ?? e })) }]} value={draft.every} onChange={(every) => change((d) => ({ ...d, every }))} />
        {errors.every ? <FieldError text={errors.every} /> : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[4], rowGap: SPACE[5] }}>
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200 }}>
          <DateField
            label={once ? 'Date' : 'First date'}
            value={draft.starts_on}
            onChange={(starts_on) => change((d) => ({ ...d, starts_on }))}
            error={errors.starts_on ?? null}
            note={day(draft.starts_on)}
            editable={!locked}
          />
        </View>
        {once ? null : (
          <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200 }}>
            <DateField
              label="Last date"
              hint="Optional."
              value={draft.ends_on}
              onChange={(ends_on) => change((d) => ({ ...d, ends_on }))}
              suggestions={[{ day: '', label: 'No end' }]}
              error={errors.ends_on ?? null}
              note={draft.ends_on === '' ? 'No end.' : day(draft.ends_on)}
              editable={!locked}
            />
          </View>
        )}
      </View>
      {draft.kind === 'allowance' ? null : (
        <View style={{ gap: SPACE[2] }}>
          <Label>On a weekend</Label>
          <Choices layout="chips" label="On a weekend" groups={[{ choices: allowedRoll.map((r) => ({ value: r, title: ROLL_WORDS[r] ?? r })) }]} value={draft.roll} onChange={(roll) => change((d) => ({ ...d, roll }))} />
          {errors.roll ? <FieldError text={errors.roll} /> : null}
        </View>
      )}
    </View>
  )
}

function ConfirmDelete({ name, busy, disabled, onCancel, onDelete }: { name: string; busy: boolean; disabled: boolean; onCancel: () => void; onDelete: () => void }) {
  const cancel = useRef<View>(null)
  // Focus lands on Cancel, so Return never deletes by accident.
  useFocusOnMount(cancel)
  return (
    <View style={{ gap: SPACE[3] }}>
      <Text variant="headline">{`Delete ${name}?`}</Text>
      <Text tone="text2">It leaves the plan, with every month it covered. Nothing is linked to it, so no payment changes.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
        <Button ref={cancel} label="Cancel" onPress={onCancel} />
        <Button label={busy ? 'Deleting…' : 'Delete'} variant="primary" disabled={disabled} onPress={onDelete} />
      </View>
    </View>
  )
}
