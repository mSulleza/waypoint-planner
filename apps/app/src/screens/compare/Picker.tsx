import { fundingCurrency, snapshotIndex, type Lever, type LeverRegistry, type Snapshot } from '@waypoint/core'
import { registry } from '@waypoint/core/compare'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { monthTitle } from '@/shell/url.model'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Choices } from '@/ui/Choices'
import { Money } from '@/ui/Money'
import { MonthStepper } from '@/ui/MonthStepper'
import { Row } from '@/ui/Row'
import { Segmented } from '@/ui/Segmented'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { FieldError, TextField } from '@/ui/TextField'
import { useLocale, useMask } from '@/ui/theme'
import { GUTTER, ROW_MIN_HEIGHT, SPACE } from '@/ui/tokens'
import {
  draftCurrency,
  itemGroups,
  itemsFor,
  KIND_WORDS,
  leverKinds,
  monthRange,
  newDraft,
  offerCost,
  offerTargets,
  pickCard,
  pickFloorAccount,
  pickItem,
  readLever,
  withEmi,
  type DraftField,
  type LeverDraft,
  type LeverKind,
} from './compare.model'

export interface PickerProps {
  open: boolean
  onClose: () => void
  snapshot: Snapshot
  // Adds the lever, or says why it cannot be added.
  onAdd: (lever: Lever) => string | null
  // A change already on the list, opened on its own form to change in place.
  editing?: LeverDraft | null
}

// The picker (spec §7): a kind of change, then its few fields, each prefilled from the plan. The content mounts with the sheet, so each opening starts afresh.
export function Picker({ open, onClose, snapshot, onAdd, editing = null }: PickerProps) {
  // Each step starts at the top of the sheet.
  const [step, setStep] = useState<LeverKind | null>(null)
  return (
    <Sheet open={open} onClose={onClose} title={editing ? 'Change this change' : 'Add a change'} scrollKey={step ?? 'kinds'}>
      <Content snapshot={snapshot} onAdd={onAdd} onDone={onClose} onStep={setStep} initial={editing} />
    </Sheet>
  )
}

type Errors = Partial<Record<DraftField, string>>
type ChangeDraft = (next: (d: LeverDraft) => LeverDraft) => void

const Note = ({ children }: { children: ReactNode }) => (
  <Text variant="footnote" tone="text2">
    {children}
  </Text>
)

// The first of a month in the household's own date order: '1 November 2026', 'November 1, 2026'.
const firstDay = (month: string, locale: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))

const Label = ({ children }: { children: string }) => (
  <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
    {children}
  </Text>
)

interface ContentProps {
  snapshot: Snapshot
  onAdd: (lever: Lever) => string | null
  onDone: () => void
  onStep: (kind: LeverKind | null) => void
  initial: LeverDraft | null
}

function Content({ snapshot, onAdd, onDone, onStep, initial }: ContentProps) {
  const locale = useLocale()
  const reg = useMemo(() => registry(snapshot), [snapshot])
  const kinds = useMemo(() => leverKinds(reg), [reg])
  const [draft, setDraft] = useState<LeverDraft | null>(initial)
  const [attempted, setAttempted] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const read = useMemo(() => (draft ? readLever(snapshot, reg, draft, locale) : null), [snapshot, reg, draft, locale])
  const errors: Errors = attempted && read && !read.ok ? read.errors : {}
  const kind = draft?.kind ?? null
  useEffect(() => onStep(kind), [kind, onStep])
  const change: ChangeDraft = (next) => {
    setDraft((d) => (d ? next(d) : d))
    setRefused(null)
  }
  if (!draft) {
    return (
      <View style={{ gap: SPACE[3] }}>
        <Note>Each change is tried on a copy of your plan; the plan itself stays as it is.</Note>
        <Card flush>
          {kinds.map((k, i) => (
            <Row key={k} title={KIND_WORDS[k].title} detail={KIND_WORDS[k].detail} divider={i > 0} onPress={() => setDraft(newDraft(snapshot, reg, k, locale))} />
          ))}
        </Card>
      </View>
    )
  }
  const submit = () => {
    setAttempted(true)
    if (!read?.ok) return
    const problem = onAdd(read.lever)
    if (problem) setRefused(problem)
    else onDone()
  }
  const back = () => {
    setDraft(null)
    setAttempted(false)
    setRefused(null)
  }
  const props: FormProps = { snapshot, reg, draft, errors, change }
  return (
    <View style={{ gap: SPACE[5] }}>
      <Text variant="headline" level={3}>
        {KIND_WORDS[draft.kind].title}
      </Text>
      <Form kind={draft.kind} {...props} />
      {refused || errors.form ? <Banner tone="negative" title="Not added" body={refused ?? errors.form} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
        <Button label={initial ? 'Save change' : 'Add change'} variant="primary" onPress={submit} />
        <Button label="Back" accessibilityLabel="Back to the kinds of change" onPress={back} />
      </View>
    </View>
  )
}

interface FormProps {
  snapshot: Snapshot
  reg: LeverRegistry
  draft: LeverDraft
  errors: Errors
  change: ChangeDraft
}

function Form({ kind, ...props }: FormProps & { kind: LeverKind }) {
  switch (kind) {
    case 'amount':
    case 'day':
    case 'end':
    case 'remove':
    case 'upside':
      return <ItemForm {...props} />
    case 'extra':
      return <ExtraForm {...props} />
    case 'offer':
      return <OfferForm {...props} />
    case 'fx':
      return <FxForm {...props} />
    case 'gap':
      return <GapForm {...props} />
    case 'floor':
      return <FloorForm {...props} />
  }
}

function Month({ label, note, ...props }: FormProps & { label: string; note?: string }) {
  const { snapshot, reg, draft, errors, change } = props
  const range = monthRange(snapshot, reg, draft)
  return <MonthStepper label={label} value={draft.month} min={range.min} max={range.max} onChange={(month) => change((d) => ({ ...d, month }))} error={errors.month ?? null} note={note ?? null} disabled={range.min === range.max} />
}

function Amount({ label, hint, snapshot, reg, draft, errors, change }: FormProps & { label: string; hint?: string }) {
  const locale = useLocale()
  const { masked } = useMask()
  const currency = draftCurrency(snapshot, reg, draft)
  if (!currency) return null
  // The amount is what a person comes to change, so it takes the focus, unless the eye hides it.
  return <TextField label={label} hint={hint} money={{ currency }} value={draft.amount} onChangeText={(amount) => change((d) => withEmi(snapshot, { ...d, amount }, locale))} error={errors.amount ?? null} autoFocus={!masked} />
}

const ITEM_NOTES: Partial<Record<LeverKind, string>> = {
  remove: 'Every month of it leaves the comparison.',
  upside: 'Counted as expected, on its own dates.',
}

function ItemForm(props: FormProps) {
  const { snapshot, reg, draft, errors, change } = props
  const locale = useLocale()
  const groups = itemGroups(reg, draft.kind, locale)
  const item = reg.items.find((i) => i.item_id === draft.item)
  const once = item?.every === 'once'
  if (!item) {
    // Picking an item is one tap; the fields follow once it is picked.
    return (
      <View style={{ gap: SPACE[4] }}>
        {groups.map((g) => (
          <View key={g.title} style={{ gap: SPACE[2] }}>
            <Text variant="footnote" tone="text2" style={{ fontWeight: '600' }}>
              {g.title}
            </Text>
            <Card flush>
              {g.items.map((i, k) => (
                <Row key={i.item_id} title={i.name} divider={k > 0} onPress={() => change((d) => pickItem(snapshot, reg, d, i.item_id, locale))} />
              ))}
            </Card>
          </View>
        ))}
        {errors.item ? <FieldError text={errors.item} /> : null}
      </View>
    )
  }
  return (
    <View style={{ gap: SPACE[5] }}>
      <View style={{ gap: SPACE[2] }}>
        <Label>Item</Label>
        <Card flush>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2], minHeight: ROW_MIN_HEIGHT, paddingLeft: GUTTER, paddingRight: SPACE[1] }}>
            <Text style={{ flex: 1, minWidth: 0 }}>{item.name}</Text>
            {itemsFor(reg, draft.kind).length > 1 ? <Button label="Change" accessibilityLabel={`Change the item, ${item.name}`} variant="plain" size="small" onPress={() => change((d) => ({ ...d, item: null }))} /> : null}
          </View>
        </Card>
        {ITEM_NOTES[draft.kind] ? <Note>{ITEM_NOTES[draft.kind]}</Note> : null}
      </View>
      {draft.kind === 'amount' ? (
        <>
          <Amount {...props} label="New amount" hint={item.kind === 'allowance' ? 'For the whole month.' : undefined} />
          <Month {...props} label="From" note={once ? `It happens once, in ${monthTitle(item.first_month, locale)}.` : undefined} />
        </>
      ) : null}
      {draft.kind === 'day' ? (
        <>
          <TextField
            label="New day"
            hint="Day of the month, 1 to 31. A shorter month uses its last day."
            value={draft.day}
            onChangeText={(day) => change((d) => ({ ...d, day }))}
            inputMode="numeric"
            maxLength={2}
            error={errors.day ?? null}
          />
          <Month {...props} label="From" note={once ? `It happens once, in ${monthTitle(item.first_month, locale)}.` : undefined} />
        </>
      ) : null}
      {draft.kind === 'end' ? <Month {...props} label={item.kind === 'installment' ? 'Last billed month' : 'Last month'} note={`Nothing of it after ${monthTitle(draft.month, locale)}.`} /> : null}
    </View>
  )
}

function ExtraForm(props: FormProps) {
  const { snapshot, reg, draft, errors, change } = props
  const locale = useLocale()
  const index = snapshotIndex(snapshot)
  const name = (id: string) => index.accounts.get(id)?.name ?? id
  const extra = reg.extra_payment
  const choices = [
    ...(extra?.from_account_ids ?? []).map((id) => ({ value: `from:${id}`, title: `Extra for debts from ${name(id)}`, detail: 'Shared among the debts it pays, in your payoff order.' })),
    ...(extra?.debt_ids ?? []).map((id) => {
      const funder = index.accounts.get(id)?.funded_from_account_id
      return { value: `to:${id}`, title: `Into ${name(id)}`, detail: funder ? `Paid from ${name(funder)}.` : 'Paid from the account set to pay it.' }
    }),
  ]
  const once = draft.every === 'once'
  const thisMonth = draft.month === snapshot.as_of.slice(0, 7)
  return (
    <View style={{ gap: SPACE[5] }}>
      <View style={{ gap: SPACE[2] }}>
        <Label>Goes to</Label>
        <Choices<string> label="Goes to" groups={[{ choices }]} value={draft.target} onChange={(target) => change((d) => ({ ...d, target }))} />
        {errors.target ? <FieldError text={errors.target} /> : null}
      </View>
      <View style={{ gap: SPACE[2] }}>
        <Label>How often</Label>
        <Segmented<'month' | 'once'>
          label="How often"
          options={[
            { value: 'month', label: 'Every month' },
            { value: 'once', label: 'Once' },
          ]}
          value={draft.every}
          onChange={(every) => change((d) => ({ ...d, every }))}
        />
      </View>
      <Amount {...props} label="Amount" />
      <Month {...props} label={once ? 'In' : 'From'} note={thisMonth ? (once ? 'Paid today.' : 'From today.') : `From ${firstDay(draft.month, locale)}.`} />
    </View>
  )
}

function OfferForm(props: FormProps) {
  const { snapshot, reg, draft, errors, change } = props
  const locale = useLocale()
  const index = snapshotIndex(snapshot)
  const cards = reg.loan_offer?.card_ids ?? []
  const targets = offerTargets(snapshot, reg, draft.card)
  const currency = draftCurrency(snapshot, reg, draft)
  const cost = offerCost(snapshot, draft, locale)
  const thisMonth = draft.month === snapshot.as_of.slice(0, 7)
  return (
    <View style={{ gap: SPACE[5] }}>
      <View style={{ gap: SPACE[2] }}>
        <Label>Card that lends</Label>
        <Choices<string> layout="chips" label="Card that lends" groups={[{ choices: cards.map((id) => ({ value: id, title: index.accounts.get(id)?.name ?? id })) }]} value={draft.card} onChange={(id) => change((d) => pickCard(snapshot, reg, d, id, locale))} />
        {errors.card ? <FieldError text={errors.card} /> : <Note>It bills the monthly installments.</Note>}
      </View>
      <View style={{ gap: SPACE[2] }}>
        <Label>Lands in</Label>
        <Choices<string>
          layout="chips"
          label="Lands in"
          groups={[{ choices: targets.map((a) => ({ value: a.id, title: a.name })) }]}
          value={draft.to}
          onChange={(to) => change((d) => ({ ...d, to }))}
        />
        {errors.to ? <FieldError text={errors.to} /> : <Note>{`An account in ${currency ?? 'the card’s currency'}, or a debt it pays down as a planned draw.`}</Note>}
      </View>
      <Amount {...props} label="Amount borrowed" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[4], rowGap: SPACE[5] }}>
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 140 }}>
          <TextField label="Months" value={draft.term} onChangeText={(term) => change((d) => withEmi(snapshot, { ...d, term }, locale))} inputMode="numeric" maxLength={3} error={errors.term ?? null} />
        </View>
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 140 }}>
          <TextField label="Rate a month" value={draft.rate} onChangeText={(rate) => change((d) => withEmi(snapshot, { ...d, rate }, locale))} inputMode="decimal" suffix="%" maxLength={7} error={errors.rate ?? null} />
        </View>
      </View>
      <Month {...props} label="Draw month" note={thisMonth ? 'Lands today.' : `Lands on ${firstDay(draft.month, locale)}.`} />
      {currency ? (
        <View style={{ gap: SPACE[1] }}>
          <TextField
            label="Monthly installment"
            hint="Worked out as amount × (1 + rate × months) ÷ months. Type the bank’s own figure if it differs."
            money={{ currency }}
            value={draft.emi}
            onChangeText={(emi) => change((d) => ({ ...d, emi, emi_typed: emi.trim() !== '' }))}
            error={errors.emi ?? null}
          />
          {cost && !errors.emi ? (
            <Text variant="footnote" tone="text2">
              {'Pays back '}
              <Money minor={cost.total_minor} currency={cost.currency} variant="footnote" tone="text2" />
              {' in all, '}
              <Money minor={cost.extra_minor} currency={cost.currency} variant="footnote" tone="text2" />
              {' more than the amount.'}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

function FxForm({ snapshot, draft, errors, change }: FormProps) {
  const funding = fundingCurrency(snapshot) ?? ''
  return (
    <View style={{ gap: SPACE[5] }}>
      <View style={{ gap: SPACE[2] }}>
        <Label>{`${funding} against today’s rate`}</Label>
        <Segmented<'weaker' | 'stronger'>
          label={`${funding} against today’s rate`}
          options={[
            { value: 'weaker', label: 'Weaker' },
            { value: 'stronger', label: 'Stronger' },
          ]}
          value={draft.direction}
          onChange={(direction) => change((d) => ({ ...d, direction }))}
        />
      </View>
      <TextField label="By" value={draft.percent} onChangeText={(percent) => change((d) => ({ ...d, percent }))} inputMode="decimal" suffix="%" maxLength={5} error={errors.percent ?? null} note={`Every day of the projection at that rate, from today.`} />
    </View>
  )
}

function GapForm(props: FormProps) {
  const { snapshot, reg, draft, errors, change } = props
  const index = snapshotIndex(snapshot)
  const ids = reg.income_gap?.item_ids ?? []
  const ALL = '*'
  return (
    <View style={{ gap: SPACE[5] }}>
      <View style={{ gap: SPACE[2] }}>
        <Label>Which income</Label>
        <Choices<string>
          layout="chips"
          label="Which income"
          groups={[{ choices: [{ value: ALL, title: 'All income' }, ...ids.map((id) => ({ value: id, title: index.planItems.get(id)?.name ?? id }))] }]}
          value={draft.income ?? ALL}
          onChange={(id) => change((d) => ({ ...d, income: id === ALL ? null : id }))}
        />
        <Note>Cards pay only their minimum while it stops.</Note>
      </View>
      <Month {...props} label="From" />
      <TextField label="For how many months" value={draft.months} onChangeText={(months) => change((d) => ({ ...d, months }))} inputMode="numeric" maxLength={2} error={errors.months ?? null} />
    </View>
  )
}

function FloorForm(props: FormProps) {
  const { snapshot, reg, draft, errors, change } = props
  const locale = useLocale()
  const index = snapshotIndex(snapshot)
  const range = monthRange(snapshot, reg, draft)
  return (
    <View style={{ gap: SPACE[5] }}>
      <View style={{ gap: SPACE[2] }}>
        <Label>Account</Label>
        <Choices<string>
          layout="chips"
          label="Account"
          groups={[{ choices: reg.floor_windows.map((f) => ({ value: f.account_id, title: index.accounts.get(f.account_id)?.name ?? f.account_id })) }]}
          value={draft.account}
          onChange={(id) => change((d) => pickFloorAccount(snapshot, d, id, locale))}
        />
        {errors.account ? <FieldError text={errors.account} /> : null}
      </View>
      <Amount {...props} label="Floor" hint="The lowest balance to keep. 0 for none." />
      <Month {...props} label="From" />
      <View style={{ gap: SPACE[2] }}>
        <Label>Until</Label>
        <Segmented<'open' | 'month'>
          label="Until"
          options={[
            { value: 'open', label: 'No end' },
            { value: 'month', label: 'A month' },
          ]}
          value={draft.to_month === null ? 'open' : 'month'}
          onChange={(until) => change((d) => ({ ...d, to_month: until === 'open' ? null : d.month }))}
        />
      </View>
      {draft.to_month !== null ? (
        <MonthStepper label="Last month" value={draft.to_month} min={draft.month} max={range.max} onChange={(to_month) => change((d) => ({ ...d, to_month }))} error={errors.to_month ?? null} note="Months after it keep the floor the plan holds." />
      ) : null}
    </View>
  )
}
