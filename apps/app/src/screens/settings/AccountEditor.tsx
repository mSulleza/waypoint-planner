import { floorSchedule, floorScheduleCopy, type Account, type AccountKind, type Snapshot } from '@waypoint/core'
import { useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { View, type TextInput } from 'react-native'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { useSnapshot } from '@/data/hooks'
import { useDataSource } from '@/data/source'
import { useEdit } from '@/data/useEdit'
import { isDay } from '@/data/field-text'
import { randomId } from '@/data/uuid'
import { Missing } from '@/shell/Missing'
import { monthTitle, NEW_ACCOUNT_ID } from '@/shell/url.model'
import { useBack } from '@/shell/useBack'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Checkbox } from '@/ui/Checkbox'
import { Choices } from '@/ui/Choices'
import { CopyText } from '@/ui/CopyText'
import { MonthStepper } from '@/ui/MonthStepper'
import { Segmented } from '@/ui/Segmented'
import { Text } from '@/ui/Text'
import { DateField } from '@/ui/DateField'
import { FieldError, TextField } from '@/ui/TextField'
import { useFocusOnMount, useLocale } from '@/ui/theme'
import { GUTTER, SPACE } from '@/ui/tokens'
import { useZodForm } from '@/ui/useZodForm'
import { presetGroups } from '../onboarding/onboarding.model'
import {
  ACCOUNT_SCHEMA,
  accountChecks,
  archiveAccount,
  changedElsewhere,
  DAY_COUNTS,
  DUE_WORDS,
  FIELD_NAMES,
  FLOOR_LINE,
  funderChoices,
  inUse,
  KIND_ORDER,
  KIND_WORDS,
  matchesPreset,
  METHOD_WORDS,
  newFloor,
  openAccount,
  PAY_ON_WORDS,
  PAY_WORDS,
  PERIOD_WORDS,
  readableFloors,
  readAccount,
  ROLL_WORDS,
  ROUNDING_WORDS,
  saveAccount,
  shownCurrency,
  thisMonth,
  withKind,
  withPreset,
  type AccountDraft,
  type DayCount,
  type DueKind,
  type FloorDraft,
  type Method,
  type Opened,
  type PayMode,
  type PayOn,
  type Period,
  type Rounding,
  type Roll,
} from './account.model'

// The account editor (spec §7): /settings/account/<id> edits an account, /settings/account/new adds one, with ?kind= to start it.
export function AccountEditor({ id }: { id: string }) {
  const params = useLocalSearchParams<{ kind?: string }>()
  const { snapshot } = useSnapshot()
  const locale = useLocale()
  const [round, setRound] = useState(0)
  // The first opening decides new, edit or missing, so a reload after a write keeps the form.
  const opened = useRef<Opened | null>(null)
  if (snapshot && opened.current === null) opened.current = openAccount(snapshot, id, NEW_ACCOUNT_ID, params, locale)
  const shown = opened.current
  if (!snapshot || !shown) return null
  if (shown.kind === 'missing') return <Missing what="account" list="/settings" listTitle="Settings" />
  const reload = () => {
    opened.current = openAccount(snapshot, id, NEW_ACCOUNT_ID, params, locale)
    setRound((r) => r + 1)
  }
  return <Form key={round} snapshot={snapshot} loaded={shown.kind === 'edit' ? shown.account : null} initial={shown.draft} reload={reload} />
}

interface FormProps {
  snapshot: Snapshot
  // The row as it was when the form opened: Save and Archive write only while the table still holds it.
  loaded: Account | null
  initial: AccountDraft
  reload: () => void
}

type Action = 'save' | 'archive'

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

const Heading = ({ children, note }: { children: string; note?: string }) => (
  <View style={{ gap: SPACE[1] }}>
    <Text variant="title2" level={2}>
      {children}
    </Text>
    {note ? <Note>{note}</Note> : null}
  </View>
)

// Two fields side by side where there is room, one above the other on a phone.
const Pair = ({ children }: { children: ReactNode }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[4], rowGap: SPACE[5] }}>{children}</View>
const Half = ({ children }: { children: ReactNode }) => <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200 }}>{children}</View>

const TERMS = /^(interest|minimum|pay)\./

function Form({ snapshot, loaded, initial, reload }: FormProps) {
  const locale = useLocale()
  const { writable, source, offline } = useSnapshot()
  const { owner } = useDataSource()
  const edit = useEdit()
  // Made once per opening, so a retry after a lost reply saves the same row.
  const [id] = useState(() => loaded?.id ?? randomId())
  const [action, setAction] = useState<Action | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [showTerms, setShowTerms] = useState(false)
  const read = useCallback((d: AccountDraft) => readAccount(snapshot, d, { id, locale, loaded }), [snapshot, id, locale, loaded])
  const check = useCallback((row: Account) => accountChecks(snapshot, row, loaded, locale), [snapshot, loaded, locale])
  const form = useZodForm<AccountDraft, Account, string>({ schema: ACCOUNT_SCHEMA, initial, read, check, names: FIELD_NAMES })
  const { draft, errors } = form
  const current = loaded ? snapshot.doc.accounts.find((a) => a.id === loaded.id) : undefined
  const used = loaded !== null && inUse(snapshot, loaded.id)

  const busy = edit.isPending
  const done = edit.isSuccess
  const gone = loaded !== null && !current && !busy && !done
  const changed = loaded !== null && !busy && !done && changedElsewhere(loaded, current)
  const locked = busy || done || !writable || gone
  const row = form.result.ok ? form.result.value : null
  const failure = edit.error ? asDataError(edit.error) : null

  // Back to where the person came from, or to the list when a link opened the app here.
  const leave = useBack()
  const change = (next: (d: AccountDraft) => AccountDraft) => {
    form.change(next)
    if (edit.error) edit.reset()
  }
  const set = (patch: Partial<AccountDraft>) => change((d) => ({ ...d, ...patch }))

  const save = loaded && row ? saveAccount(loaded, row) : null
  const onSave = () => {
    const value = form.attempt()
    if (!value || locked) return
    setAction('save')
    if (!loaded) return edit.mutate({ kind: 'add_account', row: { ...value, household_id: owner ?? '' } }, { onSuccess: leave })
    if (save === null) return leave()
    edit.mutate(save, { onSuccess: leave })
  }
  const onArchive = (at: string | null) => {
    if (locked || !loaded) return
    setAction('archive')
    edit.mutate(archiveAccount(loaded, at), { onSuccess: leave })
  }

  const termsWrong = Object.keys(errors).some((k) => TERMS.test(k))
  const termsOpen = showTerms || termsWrong
  const offNote = !writable ? (source.kind === 'sample' ? 'Samples are read-only. Sign in to change your own accounts.' : offline ? 'Offline: saving is off until Waypoint reaches the server again.' : 'Saving is off until your household loads.') : null
  const banner = (which: Action) =>
    failure && action === which ? (
      <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} action={failure.code === 'stale' ? { label: 'Show the latest', onPress: reload } : undefined} />
    ) : null
  const isNew = loaded === null
  // A new account starts at its name once it can be saved, also when the page was opened by its address before the household loaded.
  const nameField = useRef<TextInput>(null)
  const namedFocus = useRef(false)
  useEffect(() => {
    if (!isNew || !writable || namedFocus.current) return
    namedFocus.current = true
    nameField.current?.focus()
  }, [isNew, writable])
  const currency = shownCurrency(draft.currency, loaded?.currency ?? snapshot.doc.household.base_currency)
  const debt = draft.kind !== 'cash'

  return (
    <View style={{ gap: SPACE[6] }}>
      {loaded ? (
        <View style={{ gap: SPACE[1] }}>
          <Text variant="subhead" tone="text2">{`${KIND_WORDS[loaded.kind].title} · ${loaded.currency}`}</Text>
          {used ? <Note>Its kind and currency stay, since it has transactions or plan items.</Note> : null}
        </View>
      ) : null}
      {gone ? <Banner tone="neutral" title="Deleted elsewhere" body="This account is no longer in your household, so there is nothing to save." /> : null}
      {changed ? <Banner tone="caution" title="Changed elsewhere" body="This account changed on another device after it opened here." action={{ label: 'Show the latest', onPress: reload }} /> : null}
      {loaded?.archived_at ? <Banner tone="neutral" title="Archived" body="It is left out of totals and pickers. Its history stays." /> : null}

      {!used ? (
        <View style={{ gap: SPACE[2] }}>
          <Label>What is it?</Label>
          <Choices<AccountKind> label="What is it?" groups={[{ choices: KIND_ORDER.map((k) => ({ value: k, title: KIND_WORDS[k].title, detail: KIND_WORDS[k].detail })) }]} value={draft.kind} onChange={(k) => change((d) => withKind(snapshot, d, k, loaded?.id ?? null))} />
          {errors.kind ? <FieldError text={errors.kind} /> : null}
        </View>
      ) : null}

      <TextField ref={nameField} label="Name" value={draft.name} onChangeText={(name) => set({ name })} maxLength={40} error={errors.name ?? null} editable={!locked} autoCapitalize="words" />

      {draft.kind === 'credit_card' ? <PresetPicker draft={draft} row={row} saved={loaded?.kind === 'credit_card'} keepCurrency={used} change={change} error={errors.preset ?? null} /> : null}

      <Pair>
        {!used ? (
          <Half>
            <TextField
              label="Currency"
              hint="Every amount on it is in this currency."
              value={draft.currency}
              onChangeText={(text) => set({ currency: text })}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={3}
              numbers
              error={errors.currency ?? null}
              editable={!locked}
            />
          </Half>
        ) : null}
        <Half>
          <DateField
            label="Opening date"
            hint="The first day its transactions cover."
            value={draft.opening_date}
            onChange={(opening_date) => set({ opening_date })}
            error={errors.opening_date ?? null}
            note={isDay(draft.opening_date) ? new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${draft.opening_date}T00:00:00Z`)) : null}
            editable={!locked}
          />
        </Half>
      </Pair>

      <TextField
        label={debt ? 'Owed on the opening date' : 'Balance on the opening date'}
        hint={draft.kind === 'credit_card' ? 'Below zero when the card is in credit.' : draft.kind === 'cash' ? 'Below zero when it is overdrawn.' : undefined}
        money={{ currency }}
        value={draft.balance}
        onChangeText={(balance) => set({ balance })}
        error={errors.opening_balance_minor ?? null}
        editable={!locked}
      />

      {draft.kind === 'credit_card' ? (
        <CardTerms draft={draft} errors={errors} set={set} locked={locked} open={termsOpen} toggle={() => setShowTerms((s) => !s)} currency={currency} />
      ) : null}

      {draft.kind === 'loan' ? (
        <View style={{ gap: SPACE[5] }}>
          <Heading>Loan terms</Heading>
          <TextField label="Monthly payment" money={{ currency }} value={draft.payment} onChangeText={(payment) => set({ payment })} error={errors.payment_minor ?? null} editable={!locked} />
          <Pair>
            <Half>
              <TextField label="Yearly rate" value={draft.loan_rate} onChangeText={(loan_rate) => set({ loan_rate })} suffix="%" inputMode="decimal" numbers error={errors.annual_rate ?? null} editable={!locked} />
            </Half>
            <Half>
              <TextField label="Payment day" hint="1 to 31; a shorter month pays on its last day." value={draft.payment_day} onChangeText={(payment_day) => set({ payment_day })} inputMode="numeric" maxLength={2} numbers error={errors.payment_day ?? null} editable={!locked} />
            </Half>
          </Pair>
        </View>
      ) : null}

      <Funder snapshot={snapshot} draft={draft} id={id} change={change} error={errors.funded_from_account_id ?? null} />

      {draft.kind === 'cash' ? <Floors snapshot={snapshot} draft={draft} errors={errors} change={change} currency={currency} locked={locked} /> : null}

      {draft.kind === 'cash' ? (
        <TextField
          label="FX fee"
          hint="Taken when money leaves this account into another currency. Empty for none."
          value={draft.fx_fee}
          onChangeText={(fx_fee) => set({ fx_fee })}
          suffix="%"
          inputMode="decimal"
          numbers
          error={errors.fx_fee_pct ?? null}
          editable={!locked}
        />
      ) : null}

      <View style={{ gap: SPACE[3] }}>
        {banner('save')}
        <View style={{ gap: SPACE[2] }}>
          <View style={{ flexDirection: 'row' }}>
            <Button label={busy && action === 'save' ? 'Saving…' : isNew ? 'Add account' : 'Save'} variant="primary" onPress={onSave} disabled={locked} />
          </View>
          {offNote ? <Note>{offNote}</Note> : !form.result.ok && Object.keys(errors).length > 0 ? <Note>Correct the fields marked above.</Note> : null}
        </View>
      </View>

      {loaded ? (
        <View style={{ gap: SPACE[3] }}>
          {banner('archive')}
          {loaded.archived_at !== null ? (
            <View style={{ flexDirection: 'row', marginLeft: -SPACE[3] }}>
              <Button label={busy && action === 'archive' ? 'Unarchiving…' : 'Unarchive'} variant="plain" size="small" onPress={() => onArchive(null)} disabled={locked} />
            </View>
          ) : confirm ? (
            <ConfirmArchive name={loaded.name} planned={snapshot.doc.plan_items.some((p) => (p.from_account_id === loaded.id || p.to_account_id === loaded.id) && (p.ends_on === null || p.ends_on >= snapshot.as_of))} busy={busy && action === 'archive'} disabled={locked} onCancel={() => setConfirm(false)} onArchive={() => onArchive(new Date().toISOString())} />
          ) : (
            <View style={{ flexDirection: 'row', marginLeft: -SPACE[3] }}>
              <Button label="Archive" variant="plain" size="small" onPress={() => setConfirm(true)} disabled={locked} />
            </View>
          )}
        </View>
      ) : null}
    </View>
  )
}

interface PickerProps {
  draft: AccountDraft
  row: Account | null
  // A saved card shows the preset its terms came from, with Change to pick another.
  saved: boolean
  keepCurrency: boolean
  change: (next: (d: AccountDraft) => AccountDraft) => void
  error: string | null
}

// Spec §7: presets listed by behaviour, each with its bank variants; picking one copies its rules, which stay editable below.
function PresetPicker({ draft, row, saved, keepCurrency, change, error }: PickerProps) {
  const locale = useLocale()
  const [open, setOpen] = useState(!saved)
  const all = useMemo(() => presetGroups(locale), [locale])
  const groups = useMemo(() => all.map((g) => ({ title: g.heading, choices: g.options.map((o) => ({ value: o.id, title: o.title, detail: o.detail })) })), [all])
  const picked = all.flatMap((g) => g.options.map((o) => ({ ...o, heading: g.heading }))).find((o) => o.id === draft.preset)
  const same = matchesPreset(row)
  return (
    <View style={{ gap: SPACE[2] }}>
      <Label>How the card works</Label>
      {open ? (
        <Choices label="How the card works" groups={groups} value={draft.preset} onChange={(preset) => change((d) => withPreset(d, preset, locale, keepCurrency))} />
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: SPACE[3] }}>
          <View style={{ flexShrink: 1, gap: SPACE[1] }}>
            <Text>{picked ? picked.title : draft.preset}</Text>
            {picked ? <Note>{`${picked.heading} · ${picked.detail}`}</Note> : null}
          </View>
          {/* Its padding pulled back on both sides, so its word lines up with the column whether it sits beside the text or wraps under it. */}
          <View style={{ marginHorizontal: -SPACE[5] }}>
            <Button label="Change" variant="plain" accessibilityLabel="Change how the card works" onPress={() => setOpen(true)} />
          </View>
        </View>
      )}
      {error ? (
        <FieldError text={error} />
      ) : (
        <Note>{same === false ? 'Its terms below differ from the preset’s; picking one copies its terms back.' : open ? 'Picking one copies its interest, minimum and payment into the terms below, where each can change.' : 'Its terms below are the preset’s, and each can change.'}</Note>
      )}
    </View>
  )
}

interface TermsProps {
  draft: AccountDraft
  errors: Partial<Record<string, string>>
  set: (patch: Partial<AccountDraft>) => void
  locked: boolean
  open: boolean
  toggle: () => void
  currency: string
}

// The statement dates first, as every card needs them; interest, the minimum and what the plan pays sit behind one button.
function CardTerms({ draft, errors, set, locked, open, toggle, currency }: TermsProps) {
  return (
    <View style={{ gap: SPACE[5] }}>
      <Heading>Statement</Heading>
      <View style={{ gap: SPACE[2] }}>
        <Label>Payment due</Label>
        <Segmented<DueKind> label="Payment due" options={(['day_of_month', 'days_after_cut'] as const).map((k) => ({ value: k, label: DUE_WORDS[k] }))} value={draft.due_kind} onChange={(due_kind) => set({ due_kind })} />
      </View>
      <Pair>
        <Half>
          <TextField label="Cut day" hint="The statement's day of the month, 1 to 31." value={draft.cut_day} onChangeText={(cut_day) => set({ cut_day })} inputMode="numeric" maxLength={2} numbers error={errors.cut_day ?? null} editable={!locked} />
        </Half>
        <Half>
          <TextField
            label={draft.due_kind === 'day_of_month' ? 'Due day' : 'Days after the cut'}
            hint={draft.due_kind === 'day_of_month' ? 'Its day of the month, 1 to 31.' : 'Days from the cut to the due date, 1 to 60.'}
            value={draft.due}
            onChangeText={(due) => set({ due })}
            inputMode="numeric"
            maxLength={2}
            numbers
            error={errors.due ?? null}
            editable={!locked}
          />
        </Half>
      </Pair>
      <View style={{ gap: SPACE[2] }}>
        <Label>Due on a weekend</Label>
        <Choices<Roll> layout="chips" label="Due on a weekend" groups={[{ choices: (Object.keys(ROLL_WORDS) as Roll[]).map((r) => ({ value: r, title: ROLL_WORDS[r] })) }]} value={draft.due_roll} onChange={(due_roll) => set({ due_roll })} />
      </View>
      <View style={{ flexDirection: 'row', marginLeft: -GUTTER }}>
        <Button label="Interest, minimum and payment" icon={open ? 'chevron-up' : 'chevron-down'} variant="plain" onPress={toggle} expanded={open} />
      </View>
      {open ? (
        <View style={{ gap: SPACE[8] }}>
          <View style={{ gap: SPACE[5] }}>
            <Heading>Interest</Heading>
            <Choices<Method> label="Interest is charged" groups={[{ choices: (Object.keys(METHOD_WORDS) as Method[]).map((m) => ({ value: m, title: METHOD_WORDS[m] })) }]} value={draft.method} onChange={(method) => set({ method })} />
            <Pair>
              <Half>
                <TextField label="Rate" value={draft.rate} onChangeText={(rate) => set({ rate })} suffix="%" inputMode="decimal" numbers error={errors['interest.rate'] ?? null} editable={!locked} />
              </Half>
              <Half>
                <View style={{ gap: SPACE[2] }}>
                  <Label>Per</Label>
                  <Segmented<Period> label="Rate per" options={(Object.keys(PERIOD_WORDS) as Period[]).map((p) => ({ value: p, label: PERIOD_WORDS[p] }))} value={draft.period} onChange={(period) => set({ period })} />
                </View>
              </Half>
            </Pair>
            <View style={{ gap: SPACE[2] }}>
              <Label>Days the rate is spread over</Label>
              <Choices<string> layout="chips" label="Days the rate is spread over" groups={[{ choices: DAY_COUNTS.map((n) => ({ value: String(n), title: String(n) })) }]} value={String(draft.day_count)} onChange={(n) => set({ day_count: Number(n) as DayCount })} />
            </View>
          </View>
          <View style={{ gap: SPACE[5] }}>
            <Heading>Minimum payment</Heading>
            <Pair>
              <Half>
                <TextField label="Share of the statement total" value={draft.min_pct} onChangeText={(min_pct) => set({ min_pct })} suffix="%" inputMode="decimal" numbers error={errors['minimum.pct'] ?? null} editable={!locked} />
              </Half>
              <Half>
                <TextField label="At least" money={{ currency }} value={draft.min_floor} onChangeText={(min_floor) => set({ min_floor })} error={errors['minimum.floor_minor'] ?? null} editable={!locked} />
              </Half>
            </Pair>
            <View>
              <Checkbox label="Plus the cycle’s installments" checked={draft.add_installments} onChange={(add_installments) => set({ add_installments })} disabled={locked} />
              <Checkbox label="Plus the cycle’s interest" checked={draft.add_interest} onChange={(add_interest) => set({ add_interest })} disabled={locked} />
              <Checkbox label="Plus the cycle’s fees" checked={draft.add_fees} onChange={(add_fees) => set({ add_fees })} disabled={locked} />
            </View>
            <View style={{ gap: SPACE[2] }}>
              <Label>Rounded</Label>
              <Segmented<Rounding> label="Rounded" options={(Object.keys(ROUNDING_WORDS) as Rounding[]).map((r) => ({ value: r, label: ROUNDING_WORDS[r] }))} value={draft.rounding} onChange={(rounding) => set({ rounding })} />
            </View>
          </View>
          <View style={{ gap: SPACE[5] }}>
            <Heading note="On each statement, from the account that pays the card.">What the plan pays</Heading>
            <Choices<PayMode> label="What the plan pays" groups={[{ choices: (Object.keys(PAY_WORDS) as PayMode[]).map((m) => ({ value: m, title: PAY_WORDS[m].title, detail: PAY_WORDS[m].detail })) }]} value={draft.pay_mode} onChange={(pay_mode) => set({ pay_mode })} />
            <View style={{ gap: SPACE[2] }}>
              <Label>Paid on</Label>
              <Segmented<PayOn> label="Paid on" options={(Object.keys(PAY_ON_WORDS) as PayOn[]).map((p) => ({ value: p, label: PAY_ON_WORDS[p] }))} value={draft.pay_on} onChange={(pay_on) => set({ pay_on })} />
              {draft.pay_on === 'days_after_cut' ? (
                <TextField label="Days after the cut" hint="1 to 60." value={draft.pay_days} onChangeText={(pay_days) => set({ pay_days })} inputMode="numeric" maxLength={2} numbers error={errors['pay.on'] ?? null} editable={!locked} />
              ) : null}
            </View>
          </View>
        </View>
      ) : null}
    </View>
  )
}

interface FunderProps {
  snapshot: Snapshot
  draft: AccountDraft
  id: string
  change: (next: (d: AccountDraft) => AccountDraft) => void
  error: string | null
}

// A debt's payer is required and a cash account's top-up source optional (spec §4); both are cash accounts only.
function Funder({ snapshot, draft, id, change, error }: FunderProps) {
  const debt = draft.kind !== 'cash'
  const NONE = ''
  const accounts = funderChoices(snapshot, id, draft.funded_from)
  const label = debt ? 'Paid from' : 'Tops up from'
  const choices = [...(debt ? [] : [{ value: NONE, title: 'None' }]), ...accounts.map((a) => ({ value: a.id, title: a.archived_at === null ? a.name : `${a.name} · Archived` }))]
  return (
    <View style={{ gap: SPACE[2] }}>
      <Label>{label}</Label>
      {accounts.length === 0 && debt ? (
        <Note>No cash account yet. Add one first, so the debt has an account that pays it.</Note>
      ) : (
        <Choices<string> layout="chips" label={label} groups={[{ choices }]} value={draft.funded_from ?? NONE} onChange={(v) => change((d) => ({ ...d, funded_from: v === NONE ? null : v }))} />
      )}
      {error ? <FieldError text={error} /> : null}
      <Note>{debt ? 'Its payments, and the plan’s transfers into it, leave from this account, and follow it when you change it here.' : 'When it would go under its floor, the plan moves money in from this account.'}</Note>
    </View>
  )
}

interface FloorsProps {
  snapshot: Snapshot
  draft: AccountDraft
  errors: Partial<Record<string, string>>
  change: (next: (d: AccountDraft) => AccountDraft) => void
  currency: string
  locked: boolean
}

// Dated floor windows as rows, and the floor and target they give month by month, in the words core makes of them.
function Floors({ snapshot, draft, errors, change, currency, locked }: FloorsProps) {
  const locale = useLocale()
  const month = thisMonth(snapshot)
  const phases = floorSchedule(readableFloors(draft, currency, locale), month)
  const none = phases.every((p) => p.floor_minor === 0 && p.target_minor === 0)
  const update = (key: string, patch: Partial<FloorDraft>) => change((d) => ({ ...d, floors: d.floors.map((f) => (f.key === key ? { ...f, ...patch } : f)) }))
  return (
    <View style={{ gap: SPACE[4] }}>
      <Heading note={FLOOR_LINE}>Floor</Heading>
      {draft.floors.map((f, i) => (
        <Card key={f.key} role="group" aria-label={`Floor window ${i + 1}`} style={{ gap: SPACE[3] }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: SPACE[4], rowGap: SPACE[4] }}>
            <MonthStepper label="From" value={f.from_month} onChange={(from_month) => update(f.key, { from_month })} disabled={locked} />
            {f.open ? null : <MonthStepper label="To" value={f.to_month} min={f.from_month} onChange={(to_month) => update(f.key, { to_month })} error={errors[`floor_windows.${i}.to_month`] ?? null} disabled={locked} />}
            <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 160 }}>
              <TextField label="Amount" money={{ currency }} value={f.amount} onChangeText={(amount) => update(f.key, { amount })} error={errors[`floor_windows.${i}.amount_minor`] ?? null} editable={!locked} />
            </View>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: SPACE[3] }}>
            <Checkbox label="No end month" checked={f.open} onChange={(open) => update(f.key, { open, to_month: f.to_month < f.from_month ? f.from_month : f.to_month })} disabled={locked} />
            <View style={{ marginRight: -SPACE[3] }}>
              <Button label="Remove" variant="plain" size="small" accessibilityLabel={`Remove the window from ${monthTitle(f.from_month, locale)}`} onPress={() => change((d) => ({ ...d, floors: d.floors.filter((x) => x.key !== f.key) }))} disabled={locked} />
            </View>
          </View>
        </Card>
      ))}
      <View style={{ flexDirection: 'row', marginLeft: -GUTTER }}>
        <Button label="Add a floor window" icon="plus" variant="plain" onPress={() => change((d) => ({ ...d, floors: [...d.floors, newFloor(month)] }))} disabled={locked} />
      </View>
      {none ? <Note>No floor set: the plan neither tops it up nor flags a low month.</Note> : <CopyText copy={[{ text: 'Floor ' }, ...floorScheduleCopy(phases, currency), { text: '.' }]} variant="footnote" tone="text2" />}
    </View>
  )
}

function ConfirmArchive({ name, planned, busy, disabled, onCancel, onArchive }: { name: string; planned: boolean; busy: boolean; disabled: boolean; onCancel: () => void; onArchive: () => void }) {
  const cancel = useRef<View>(null)
  // Focus lands on Cancel, so Return never archives by accident.
  useFocusOnMount(cancel)
  return (
    <View style={{ gap: SPACE[3] }}>
      <Text variant="headline">{`Archive ${name}?`}</Text>
      <Text tone="text2">{`It leaves totals and pickers; its transactions stay, and it can be unarchived here.${planned ? ' Plan items that use it keep running until you end them.' : ''}`}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
        <Button ref={cancel} label="Cancel" onPress={onCancel} />
        <Button label={busy ? 'Archiving…' : 'Archive'} variant="primary" disabled={disabled} onPress={onArchive} />
      </View>
    </View>
  )
}
