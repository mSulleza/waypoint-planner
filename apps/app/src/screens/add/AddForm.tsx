import { convert, parseAmount, toRatesPerEur, type Category, type Snapshot } from '@waypoint/core'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Platform, View, type TextInput } from 'react-native'
import type { ReceiptRead } from '@/ai/pdf-read'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { useEngine, usePostBatch, useSnapshot } from '@/data/hooks'
import type { PickedPdf } from '@/data/pdf-file'
import { readReceiptPdf, usePdfReadEnabled } from '@/data/pdf-read'
import { useDataSource } from '@/data/source'
import { shortDay } from '@/data/status'
import { useEdit } from '@/data/useEdit'
import { randomId } from '@/data/uuid'
import { newBatchIds, readLastAccount, rememberLastAccount } from '@/data/writes'
import { PdfFill } from '@/screens/pdf/PdfFill'
import { useCloseSheet, useSheetTop } from '@/shell/RouteSheet'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Checkbox } from '@/ui/Checkbox'
import { Choices } from '@/ui/Choices'
import { FxRate, Money } from '@/ui/Money'
import { Segmented } from '@/ui/Segmented'
import { Text } from '@/ui/Text'
import { DateField } from '@/ui/DateField'
import { FieldError, TextField } from '@/ui/TextField'
import { useLocale, useMask, useTheme } from '@/ui/theme'
import { identityColor, SPACE } from '@/ui/tokens'
import { useIdentity } from '@/ui/useIdentity'
import {
  accountChoices,
  amountText,
  arrivalDays,
  cardPay,
  categoryNote,
  categoryOffer,
  dayChoices,
  debtPrefill,
  fitLink,
  isDay,
  loanPay,
  MODES,
  newCategory,
  NOTE_MAX,
  openDraft,
  overState,
  problemOf,
  readDraft,
  realRate,
  receiptDraft,
  receiptFilledNote,
  settles,
  switchMode,
  takesCategory,
  type AddParams,
  type Draft,
  type Field,
  type Mode,
  type Problem,
} from './add.model'
import { sheetWords } from './sheet-words'

const OTHER_DAY = 'other'
// A line under a checkbox starts where its label does: the 20 px box and the 12 px gap.
const CHECK_INDENT = 20 + SPACE[3]

const utc = (day: string) => new Date(`${day}T00:00:00Z`)
const dayPart = (day: string, locale: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(utc(day))
const longDay = (day: string, locale: string) => dayPart(day, locale, { weekday: 'long', day: 'numeric', month: 'long' })

// An occurrence's period: its month, or its day for a weekly item.
function periodLabel(period: string, locale: string): string {
  return period.endsWith('-01') ? dayPart(period, locale, { month: 'short', year: 'numeric' }) : shortDay(period, locale)
}

// A sentence with one amount in it, drawn through <Money> so the eye masks it.
function WithMoney({ text, money, variant = 'footnote' }: { text: string; money: { minor: number; currency: string } | null; variant?: 'footnote' | 'subhead' }) {
  const [before, after = ''] = text.split('{money}')
  return (
    <Text variant={variant} tone="text2">
      {before}
      {money ? <Money minor={money.minor} currency={money.currency} variant={variant} tone="text2" /> : null}
      {after}
    </Text>
  )
}

function Label({ children }: { children: string }) {
  return (
    <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
      {children}
    </Text>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: SPACE[2] }}>
      <Label>{label}</Label>
      {children}
    </View>
  )
}

// Two figures side by side with their names above, in tabular figures so they line up.
// A figure below zero is a credit on the card, said in words rather than with a minus sign.
function Facts({ items }: { items: { label: string; minor: number; currency: string }[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[6], rowGap: SPACE[2] }}>
      {items.map((f) => (
        <View key={f.label} style={{ gap: SPACE[1] }}>
          <Text variant="footnote" tone="text2">
            {f.label}
          </Text>
          <Money minor={f.minor} currency={f.currency} owed={f.minor < 0} variant="headline" />
        </View>
      ))}
    </View>
  )
}

export interface AddFormProps {
  // Where the sheet puts focus on open; left empty when a prefilled amount stays masked.
  focus: RefObject<{ focus: () => void } | null>
}

// The Add sheet's content (spec §7): Out, In or Move with every prefill, saved as one post_batch.
export function AddForm({ focus }: AddFormProps) {
  const { snapshot } = useSnapshot()
  return snapshot ? <Form snapshot={snapshot} focus={focus} /> : null
}

function Form({ snapshot, focus }: { snapshot: Snapshot } & AddFormProps) {
  const params = useLocalSearchParams<Record<keyof AddParams, string>>()
  const router = useRouter()
  const close = useCloseSheet()
  const toTop = useSheetTop()
  const { writable, source, offline } = useSnapshot()
  const run = useEngine()
  const walk = run?.ok ? run.walk : null
  const locale = useLocale()
  const { masked } = useMask()
  const save = usePostBatch()

  // Made once when the sheet opens: the ids every retry resends, and the draft the address and the figures prefill.
  const [ids] = useState(newBatchIds)
  const [opening] = useState(() => openDraft(snapshot, walk, params, readLastAccount(), locale))
  const [draft, setDraft] = useState<Draft>(opening.draft)
  const [tried, setTried] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [allCategories, setAllCategories] = useState(false)
  const [otherDay, setOtherDay] = useState(false)
  const refs = useRef<Partial<Record<Field, { focus: () => void } | null>>>({})
  // 'New category…' while open: the name typed, on an id made when it opened, so a retry adds one category.
  const [naming, setNaming] = useState<{ id: string; text: string; tried: boolean; waiting: boolean } | null>(null)
  const made = useEdit()
  const { owner } = useDataSource()
  const nameRef = useRef<TextInput | null>(null)
  const newRef = useRef<View | null>(null)

  const index = useMemo(() => new Map(snapshot.doc.accounts.map((a) => [a.id, a])), [snapshot])
  const account = draft.account === null ? undefined : index.get(draft.account)
  const to = draft.mode === 'move' && draft.to !== null ? index.get(draft.to) : undefined
  const across = to !== undefined && account !== undefined && to.currency !== account.currency
  const card = useMemo(() => (walk && to?.kind === 'credit_card' ? cardPay(snapshot, walk, to.id) : null), [snapshot, walk, to])
  const loan = useMemo(() => (walk && to?.kind === 'loan' ? loanPay(snapshot, walk, to.id, draft.account) : null), [snapshot, walk, to, draft.account])
  const landed = to ? parseAmount(across ? draft.received : draft.amount, locale, to.currency) : null
  const over = overState(card, landed, draft.over)
  const reading = readDraft(snapshot, draft, { locale, ids, allow_over: over.allow, escrow: loan?.escrow ?? null })
  const sentMinor = account ? parseAmount(draft.amount, locale, account.currency) : null
  const offer = useMemo(() => (takesCategory(draft) ? categoryOffer(snapshot, draft.date, draft.category) : null), [snapshot, draft])
  const match = useMemo(() => settles(snapshot, draft, sentMinor), [snapshot, draft, sentMinor])
  const rate = across && account && to && sentMinor !== null && landed !== null ? realRate(snapshot, sentMinor, account.currency, landed, to.currency) : null
  // A payment across currencies with only what lands typed: what it may take from Sent at today's rate.
  const estimate = across && account && to && sentMinor === null && landed !== null && landed > 0 ? convert(landed, to.currency, account.currency, toRatesPerEur(snapshot.rates)) : null
  const errors = tried ? reading.errors : {}
  const named = naming ? newCategory(snapshot, naming.text, naming.id, owner ?? '') : null
  const madeFailure = made.error ? asDataError(made.error) : null

  // Pay on a card whose cut passed with no statement opens the Statement sheet for it first.
  useEffect(() => {
    if (opening.statement_first) router.replace({ pathname: '/statement', params: { account: opening.statement_first } })
  }, [opening.statement_first, router])

  // Focus on open: nothing while a prefilled amount stays masked, else the first amount still empty.
  const [target] = useState<Field | null>(() => (masked && opening.prefilled ? null : opening.draft.amount !== '' && opening.draft.received === '' && across ? 'received' : 'amount'))
  useEffect(() => {
    focus.current = { focus: () => (target ? refs.current[target]?.focus() : undefined) }
    // The form may draw after the sheet opened (the household was still loading); it then takes the focus itself, after the modal's focus trap. A timer, as a background tab draws no frames.
    if (Platform.OS !== 'web' || !target) return
    const timer = setTimeout(() => refs.current[target]?.focus(), 0)
    return () => clearTimeout(timer)
  }, [focus, target])

  // The name field takes the focus when it opens; closing it gives the focus back to 'New category…'.
  const namingId = naming?.id ?? null
  const wasNaming = useRef(false)
  useEffect(() => {
    if (namingId) nameRef.current?.focus()
    else if (wasNaming.current) newRef.current?.focus()
    wasNaming.current = namingId !== null
  }, [namingId])

  // Until the person types an amount, a new From or To brings that debt's own prefill.
  const [typed, setTyped] = useState(params.amount !== undefined)
  const change = (patch: Partial<Draft>) => {
    setDraft((d) => {
      const next = { ...d, ...patch }
      const moved = next.mode === 'move' && !typed && ('to' in patch || 'account' in patch)
      const pay = moved ? debtPrefill(snapshot, walk, next.account, next.to, locale) : null
      return fitLink(snapshot, moved ? { ...next, amount: pay?.amount ?? '', received: pay?.received ?? '', escrow: pay?.escrow ?? false, escrow_amount: pay?.escrow_amount ?? '' } : next)
    })
    setProblem(null)
  }
  const type = (patch: Partial<Draft>) => {
    setTyped(true)
    change(patch)
  }
  const pickMode = (mode: Mode) => {
    setDraft((d) => switchMode(snapshot, d, mode, readLastAccount()))
    setProblem(null)
    router.setParams({ mode })
  }

  const pdfOn = usePdfReadEnabled() && writable
  const [fromPdf, setFromPdf] = useState<{ name: string; note: string } | null>(null)
  const [pdfProblem, setPdfProblem] = useState<string | null>(null)
  const openCategories = useMemo(() => snapshot.doc.categories.filter((c) => c.archived_at === null).map((c) => ({ id: c.id, name: c.name })), [snapshot])
  // A receipt fills Out as if typed; the amount then counts as typed, so a new account keeps it.
  const onReceipt = (answer: ReceiptRead, file: PickedPdf) => {
    const filled = receiptDraft(snapshot, draft, answer, locale)
    setPdfProblem('mismatch' in filled ? filled.mismatch : null)
    setFromPdf('mismatch' in filled ? null : { name: file.name, note: receiptFilledNote(answer) })
    if ('draft' in filled) type(filled.draft)
  }

  const sending = save.isPending
  const onSave = async () => {
    setTried(true)
    if (!writable || made.isPending) return
    // A name typed and not saved would be lost, so it is saved or cancelled first.
    if (offer && naming && naming.text.trim() !== '') {
      setNaming({ ...naming, tried: true, waiting: true })
      nameRef.current?.focus()
      return
    }
    const input = reading.input
    if (!input) {
      const first = (['amount', 'received', 'escrow', 'date', 'note'] as const).find((f) => f in reading.errors)
      if (first) refs.current[first]?.focus()
      return
    }
    setProblem(null)
    try {
      // A second tap sends the same ids, which post_batch answers with already_applied.
      await save.mutateAsync(input)
      if (draft.account) rememberLastAccount(draft.account)
      close()
    } catch (error) {
      const found = problemOf(snapshot, asDataError(error), input, locale)
      setProblem(found)
      // The refusal shows under the amount it names, at the top of the sheet: the focus goes there, or under the eye the sheet scrolls up, so the amount stays masked.
      if (found.field !== 'form') {
        if (masked) toTop()
        else refs.current[found.field]?.focus()
      }
    }
  }

  const startNaming = () => {
    made.reset()
    setNaming({ id: randomId(), text: '', tried: false, waiting: false })
  }
  const stopNaming = () => {
    made.reset()
    setNaming(null)
  }
  const pickExisting = (c: Category) => {
    stopNaming()
    change({ category: c.id })
  }
  // Settings' add_category write, then the new category is picked; the sheet keeps everything else.
  const onName = async () => {
    if (!naming || made.isPending) return
    setNaming({ ...naming, tried: true })
    if (!writable || owner === null || !named || !('edit' in named)) return
    try {
      await made.mutateAsync(named.edit)
      setNaming(null)
      change({ category: naming.id })
    } catch {
      // The refusal shows under the name or above its Save.
    }
  }

  const money = (field: Field, currency: string | undefined) => ({
    ref: (r: TextInput | null) => {
      refs.current[field] = r
    },
    money: { currency: currency ?? '' },
    error: errors[field] ?? null,
    editable: !sending,
    autoFocus: Platform.OS !== 'web' && target === field,
  })
  const amountProblem = problem && problem.field !== 'form' ? problem : null

  const { scheme } = useTheme()
  const colourOf = useIdentity()
  const accountsFor = (role: 'account' | 'to') => accountChoices(snapshot, draft.mode, role, role === 'to' ? draft.account : null).map((a) => ({ value: a.id, title: a.name, colour: identityColor(colourOf(a.id), scheme) }))
  const days = dayChoices(snapshot.as_of)
  const dayValue = otherDay || !days.some((d) => d.value === draft.date) ? OTHER_DAY : draft.date

  const amountField = (
    <View style={{ gap: SPACE[2] }}>
      <TextField
        {...money('amount', account?.currency)}
        label={draft.mode === 'move' && across ? 'Sent' : 'Amount'}
        value={draft.amount}
        onChangeText={(amount) => type({ amount })}
        enterKeyHint={across ? 'next' : 'done'}
        onSubmitEditing={() => (across ? refs.current.received?.focus() : void onSave())}
        large
      />
      {estimate && account ? (
        // What the bank will take is the person's to type; today's rate only suggests it.
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[1] }}>
          <Text variant="footnote" tone="text2">
            {'About '}
            <Money minor={estimate} currency={account.currency} variant="footnote" tone="text2" />
            {' at today’s rate'}
          </Text>
          <View style={{ marginVertical: -SPACE[2] }}>
            <Button label="Use it" accessibilityLabel="Use today’s rate for Sent" variant="plain" size="small" onPress={() => type({ amount: amountText(estimate, account.currency, locale) })} />
          </View>
        </View>
      ) : null}
      {amountProblem?.field === 'amount' ? (
        <FieldError>
          <ProblemText problem={amountProblem} />
        </FieldError>
      ) : null}
    </View>
  )

  const receivedField = across ? (
    <View style={{ gap: SPACE[2] }}>
      <TextField
        {...money('received', to?.currency)}
        label="Received"
        hint={`What landed in ${to?.name ?? 'the account'}, from the bank’s record.`}
        value={draft.received}
        onChangeText={(received) => type({ received })}
        enterKeyHint="done"
        onSubmitEditing={() => void onSave()}
      />
      {amountProblem?.field === 'received' ? (
        <FieldError>
          <ProblemText problem={amountProblem} />
        </FieldError>
      ) : null}
      {rate ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: SPACE[1] }}>
          <Text variant="footnote" tone="text2">
            Rate
          </Text>
          <FxRate from={rate.from} to={rate.to} unitMinor={rate.unit_minor} quoteMinor={rate.quote_minor} />
          {rate.below_ecb !== null ? (
            <Text variant="footnote" tone="text2">
              {`· ${new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(Math.abs(rate.below_ecb))} ${rate.below_ecb >= 0 ? 'below' : 'above'} the ECB rate`}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  ) : null

  const cardFacts =
    to?.kind === 'credit_card' && card ? (
      card.provisional ? (
        <Banner
          tone="caution"
          title="Statement not entered"
          body={`${to.name}’s statement of ${shortDay(card.cut_date, locale)} is not entered, so the remaining due still counts from the last one. Enter it first to pay the right amount.`}
          action={{ label: 'Enter statement', onPress: () => router.replace({ pathname: '/statement', params: { account: to.id } }) }}
        />
      ) : (
        <View style={{ gap: SPACE[2] }}>
          <Facts
            items={[
              { label: 'Left to pay', minor: card.left_minor, currency: card.currency },
              { label: 'Remaining due', minor: card.remaining_minor, currency: card.currency },
            ]}
          />
          <Text variant="footnote" tone="text2">{`Statement of ${shortDay(card.cut_date, locale)}, due ${shortDay(card.due_date, locale)}`}</Text>
          <View>
            <Checkbox label="Paid more than due" checked={over.allow} onChange={(v) => change({ over: v })} disabled={sending} />
            {over.allow && over.auto ? (
              <View style={{ paddingLeft: CHECK_INDENT, marginTop: -SPACE[2] }}>
                {over.charged_minor > 0 ? <WithMoney text="Includes {money} charged since the statement" money={{ minor: over.charged_minor, currency: card.currency }} /> : null}
                {over.planned_minor > 0 ? <WithMoney text={`${over.charged_minor > 0 ? 'and' : 'Includes'} {money} the plan adds to this payment`} money={{ minor: over.planned_minor, currency: card.currency }} /> : null}
              </View>
            ) : null}
          </View>
        </View>
      )
    ) : null

  const loanFacts =
    to?.kind === 'loan' && loan ? (
      <View style={{ gap: SPACE[2] }}>
        <WithMoney text={`Next payment {money}, ${loan.overdue ? 'was due' : 'due'} ${shortDay(loan.on, locale)}`} money={{ minor: loan.due_minor, currency: loan.currency }} variant="subhead" />
        {loan.escrow ? (
          <>
            <Checkbox label={`Include ${loan.escrow.name}`} detail={`Saved as an expense that settles ${loan.escrow.name} for ${periodLabel(loan.escrow.period, locale)}.`} checked={draft.escrow} onChange={(escrow) => change({ escrow })} disabled={sending} />
            {draft.escrow ? <TextField {...money('escrow', account?.currency)} label={`${loan.escrow.name} amount`} value={draft.escrow_amount} onChangeText={(escrow_amount) => type({ escrow_amount })} /> : null}
          </>
        ) : null}
      </View>
    ) : null

  const monthName = dayPart(isDay(draft.date) ? draft.date : snapshot.as_of, locale, { month: 'long', year: 'numeric' })
  const tagNote = offer ? categoryNote(snapshot, draft, offer, monthName) : null
  const offered = named && 'use' in named ? named.use : null
  // A name in use shows at once with the category it names; an empty name only after Save.
  const nameError = !named ? null : 'error' in named && (naming?.tried || named.existing) ? named.error : naming?.waiting ? 'Save the new category first, or cancel it.' : madeFailure?.code === 'category_exists' ? madeFailure.message : null
  const nameForm = naming ? (
    <View style={{ gap: SPACE[2] }}>
      <TextField
        ref={nameRef}
        label="New category"
        value={naming.text}
        onChangeText={(text) => {
          setNaming({ ...naming, text, waiting: false })
          if (made.error) made.reset()
        }}
        maxLength={40}
        autoCapitalize="sentences"
        error={nameError}
        editable={!made.isPending && !sending}
        enterKeyHint="done"
        onSubmitEditing={() => void onName()}
      />
      {offered ? (
        <View style={{ flexDirection: 'row', marginHorizontal: -SPACE[3] }}>
          <Button label={`Use ${offered.name}`} variant="plain" size="small" onPress={() => pickExisting(offered)} />
        </View>
      ) : null}
      {madeFailure && madeFailure.code !== 'category_exists' ? <Banner tone="negative" title={ERROR_TITLES[madeFailure.kind]} body={madeFailure.message} detail={madeFailure.technical ?? undefined} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>
        <Button label={made.isPending ? 'Saving…' : 'Save'} accessibilityLabel="Save category" size="small" onPress={() => void onName()} disabled={!writable || made.isPending || sending} />
        <Button label="Cancel" accessibilityLabel="Cancel new category" variant="plain" size="small" onPress={stopNaming} disabled={made.isPending} />
      </View>
    </View>
  ) : null
  const moreCategories = offer !== null && !allCategories && offer.all.length > offer.chips.filter((c) => offer.all.includes(c)).length
  const categories = offer ? (
    <Group label="Category">
      <Choices
        layout="chips"
        label="Category"
        groups={[{ choices: (allCategories ? [...offer.all, ...offer.chips.filter((c) => !offer.all.includes(c))] : offer.chips).map((c) => ({ value: c.id, title: c.name })) }]}
        value={draft.category}
        onChange={(id) => change({ category: id === draft.category ? null : id })}
      />
      {nameForm ?? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -SPACE[3] }}>
          {moreCategories ? <Button label="All categories" variant="plain" size="small" onPress={() => setAllCategories(true)} /> : null}
          <Button ref={newRef} label="New category…" variant="plain" size="small" onPress={startNaming} disabled={!writable || sending} />
        </View>
      )}
      {tagNote ? <Text variant="footnote" tone="text2">{tagNote}</Text> : null}
    </Group>
  ) : null

  const accounts =
    draft.mode === 'move' ? (
      <>
        <Group label="From">
          <Choices layout="chips" label="From" groups={[{ choices: accountsFor('account') }]} value={draft.account} onChange={(id) => change({ account: id, to: draft.to === id ? null : draft.to, over: null })} />
          {errors.account ? <FieldError text={errors.account} /> : null}
        </Group>
        <Group label="To">
          <Choices layout="chips" label="To" groups={[{ choices: accountsFor('to') }]} value={draft.to} onChange={(id) => change({ to: id, over: null })} />
          {errors.to ? <FieldError text={errors.to} /> : null}
        </Group>
      </>
    ) : (
      <Group label={draft.mode === 'in' ? 'Into' : 'From'}>
        <Choices layout="chips" label={draft.mode === 'in' ? 'Into' : 'From'} groups={[{ choices: accountsFor('account') }]} value={draft.account} onChange={(id) => change({ account: id })} />
        {errors.account ? <FieldError text={errors.account} /> : null}
      </Group>
    )

  const settle = match ? (
    <View style={{ gap: SPACE[1] }}>
      <Checkbox
        variant="chip"
        label={`Settles: ${match.name} · ${periodLabel(match.occurrence.period, locale)}`}
        checked={match.chosen}
        onChange={(on) => change({ link: on ? { plan_item_id: match.occurrence.plan_item_id, period: match.occurrence.period } : null })}
        disabled={sending}
      />
      {errors.link ? <FieldError text={errors.link} /> : null}
    </View>
  ) : null

  const when = (
    <>
      <Group label={draft.mode === 'move' ? 'Sent on' : 'Date'}>
        <Choices
          layout="chips"
          label={draft.mode === 'move' ? 'Sent on' : 'Date'}
          groups={[{ choices: [...days.map((d) => ({ value: d.value, title: d.title, label: `${d.title}, ${longDay(d.value, locale)}` })), { value: OTHER_DAY, title: 'Other day' }] }]}
          value={dayValue}
          onChange={(v) => {
            setOtherDay(v === OTHER_DAY)
            if (v !== OTHER_DAY) change({ date: v, arrives: v })
          }}
        />
        {dayValue === OTHER_DAY ? (
          <DateField
            ref={(r) => {
              refs.current.date = r
            }}
            label="Day"
            value={draft.date}
            onChange={(date) => change({ date, arrives: date })}
            error={errors.date ?? null}
            note={isDay(draft.date) ? longDay(draft.date, locale) : null}
          />
        ) : errors.date ? (
          <FieldError text={errors.date} />
        ) : null}
      </Group>
      {draft.mode === 'move' && arrivalDays(draft.date).length > 0 ? (
        <Group label="Arrives">
          <Choices
            layout="chips"
            label="Arrives"
            groups={[{ choices: arrivalDays(draft.date).map((d, i) => ({ value: d, title: i === 0 ? 'Same day' : dayPart(d, locale, { day: 'numeric' }), detail: i === 0 ? undefined : dayPart(d, locale, { weekday: 'short' }), label: longDay(d, locale) })) }]}
            value={draft.arrives}
            onChange={(arrives) => change({ arrives })}
          />
          {errors.arrives ? <FieldError text={errors.arrives} /> : null}
        </Group>
      ) : null}
    </>
  )

  const note = (
    <TextField
      ref={(r) => {
        refs.current.note = r
      }}
      label="Note"
      hint="Optional."
      value={draft.note}
      onChangeText={(text) => change({ note: text })}
      maxLength={NOTE_MAX}
      error={errors.note ?? null}
      editable={!sending}
      enterKeyHint="done"
      onSubmitEditing={() => void onSave()}
    />
  )

  const offNote = !writable ? (source.kind === 'sample' ? 'Saving is off in samples.' : offline ? 'Offline: saving is off until Waypoint reaches the server again.' : 'Saving is off until your household loads.') : null

  // Pay on a card whose cut passed with no statement draws nothing while the Statement sheet takes its place.
  if (opening.statement_first) return null

  return (
    <View style={{ gap: SPACE[5] }}>
      <Segmented label="Kind of entry" options={MODES} value={draft.mode} onChange={pickMode} />
      {pdfOn && draft.mode === 'out' ? (
        <PdfFill label="Fill from a receipt PDF" read={(file, password) => readReceiptPdf(file, password, account?.currency ?? snapshot.doc.household.base_currency, openCategories)} onRead={onReceipt} disabled={sending} />
      ) : null}
      {pdfProblem ? <Banner tone="negative" title="Not filled" body={pdfProblem} /> : null}
      {fromPdf && draft.mode === 'out' ? <Banner tone="neutral" title={`Filled from ${fromPdf.name}`} body={fromPdf.note} /> : null}
      {amountField}
      {draft.mode === 'move' ? (
        <>
          {receivedField}
          {cardFacts}
          {loanFacts}
          {accounts}
        </>
      ) : (
        <>
          {/* Income that settles a planned inflow is not a refund. */}
          {draft.mode === 'in' && draft.link === null ? <Checkbox label="Refund" detail="Money back for something bought; it can carry a category." checked={draft.refund} onChange={(refund) => change({ refund })} disabled={sending} /> : null}
          {categories}
          {accounts}
        </>
      )}
      {settle}
      {when}
      {note}
      {problem && problem.field === 'form' ? <Banner tone="negative" title="Not saved" body={problem.text} detail={problem.technical ?? undefined} /> : null}
      <View style={{ gap: SPACE[2] }}>
        <Button label={sending ? 'Saving…' : draft.mode === 'move' ? sheetWords(snapshot.doc, params).save : 'Save'} variant="primary" onPress={() => void onSave()} disabled={!writable || sending || made.isPending} />
        {offNote ? (
          <Text variant="footnote" tone="text2" style={{ textAlign: 'center' }}>
            {offNote}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

function ProblemText({ problem }: { problem: Problem }) {
  const [before, after = ''] = problem.text.split('{money}')
  return (
    <>
      {before}
      {problem.money ? <Money minor={problem.money.minor} currency={problem.money.currency} variant="footnote" style={{ fontWeight: '600' }} /> : null}
      {after}
    </>
  )
}
