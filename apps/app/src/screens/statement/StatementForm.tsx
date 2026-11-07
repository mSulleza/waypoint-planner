import { dueDate, type CardAccount, type Snapshot, type Statement } from '@waypoint/core'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Platform, View } from 'react-native'
import type { StatementRead as PdfStatement } from '@/ai/pdf-read'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { isDay } from '@/data/field-text'
import { useSnapshot } from '@/data/hooks'
import type { PickedPdf } from '@/data/pdf-file'
import { readStatementPdf, usePdfReadEnabled } from '@/data/pdf-read'
import { useDataSource } from '@/data/source'
import { shortDay } from '@/data/status'
import { useEdit } from '@/data/useEdit'
import { randomId } from '@/data/uuid'
import { PdfFill } from '@/screens/pdf/PdfFill'
import { useCloseSheet } from '@/shell/RouteSheet'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Checkbox } from '@/ui/Checkbox'
import { Money } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Text } from '@/ui/Text'
import { DateField } from '@/ui/DateField'
import { TextField } from '@/ui/TextField'
import { useLocale, useTheme } from '@/ui/theme'
import { identityColor, SPACE, SWATCH } from '@/ui/tokens'
import { useIdentity } from '@/ui/useIdentity'
import {
  blockedBy,
  changeCut,
  cutChoices,
  draftFromPdf,
  draftWarnings,
  initialDraft,
  LABELS,
  openingEdit,
  openStatement,
  paymentsSum,
  pdfFilledNote,
  pdfMismatch,
  readDay,
  readStatement,
  statementEdit,
  statementProblem,
  type Check,
  type DraftWarning,
  type Field,
  type StatementDraft,
} from './statement.model'

export interface StatementFormProps {
  // Where the sheet puts focus on open.
  focus: RefObject<{ focus: () => void } | null>
}

// Spec §7 Statement: /statement?account=<card> enters a printed statement, and &statement=<id> edits a saved one.
export function StatementForm({ focus }: StatementFormProps) {
  const params = useLocalSearchParams<{ account?: string; statement?: string }>()
  const router = useRouter()
  const { snapshot } = useSnapshot()
  // Show the latest: the form opens again from what is saved now.
  const [round, setRound] = useState(0)
  const opened = useMemo(() => (snapshot ? openStatement(snapshot, params.account, params.statement) : null), [snapshot, params.account, params.statement])
  if (!snapshot || !opened) return null
  if (opened.kind === 'no_card') return <Text tone="text2">This household has no card at this link.</Text>
  if (opened.kind === 'no_statement') {
    return <Banner tone="neutral" title="This statement is no longer saved" body="It was deleted elsewhere." action={{ label: 'Enter a new one', onPress: () => router.setParams({ statement: undefined }) }} />
  }
  return <Form key={`${params.statement ?? 'new'}:${round}`} snapshot={snapshot} card={opened.card} editing={opened.editing} focus={focus} reload={() => setRound((r) => r + 1)} />
}

interface FormProps extends StatementFormProps {
  snapshot: Snapshot
  card: CardAccount
  editing: Statement | null
  reload: () => void
}

// What each warning compares the printed figure with.
const EXPECTED: Record<DraftWarning['kind'], string> = {
  previous_balance: 'the last statement’s total due is',
  payments_and_credits: 'you logged',
  installments: 'your plan bills',
}

function Form({ snapshot, card, editing, focus, reload }: FormProps) {
  const locale = useLocale()
  const router = useRouter()
  const close = useCloseSheet()
  const { writable, source, offline } = useSnapshot()
  const { owner } = useDataSource()
  const save = useEdit()
  // The statement as it was when the form opened: an edit saves only while the table still holds it.
  const [loaded] = useState(editing)
  // Made once per opening, so a retry after a lost reply saves the same row.
  const [id] = useState(() => editing?.id ?? randomId())
  const [draft, setDraft] = useState<StatementDraft>(() => initialDraft(snapshot, card, editing, locale))
  const read = useMemo(() => readStatement(snapshot, card, draft, { id, locale }), [snapshot, card, draft, id, locale])
  // The warnings replay the card's cycle, so they follow typing a moment behind.
  const later = useDeferredValue(draft)
  const warnings = useMemo(() => draftWarnings(snapshot, card, later, readStatement(snapshot, card, later, { id, locale }), id), [snapshot, card, later, id, locale])
  const refs = useRef<Partial<Record<Field, { focus: () => void } | null>>>({})

  // A new statement starts on the first figure to type; an edit, or a cut already entered, on the cut date, so no saved amount is focused (and unmasked) on open.
  const [target] = useState<Field>(() => (editing || read.duplicate ? 'cut' : draft.total_only ? 'total' : 'previous'))
  useEffect(() => {
    focus.current = { focus: () => refs.current[target]?.focus() }
    // The form draws after the sheet opened (its code loads apart), so it takes the focus itself; a timer, as a background tab draws no frames.
    if (Platform.OS !== 'web') return
    const timer = setTimeout(() => refs.current[target]?.focus(), 0)
    return () => clearTimeout(timer)
  }, [focus, target])

  const sending = save.isPending
  const change = (next: (d: StatementDraft) => StatementDraft) => {
    setDraft(next)
    if (save.error) save.reset()
  }
  const set = (patch: Partial<StatementDraft>) => change((d) => ({ ...d, ...patch }))
  const ref = (f: Field) => (r: { focus: () => void } | null) => {
    refs.current[f] = r
  }
  // After the field it names has drawn.
  const focusSoon = (f: Field) => setTimeout(() => refs.current[f]?.focus(), 0)

  // Return in any field saves once the statement can be saved, as a form's Enter does.
  const onSave = () => {
    if (sending || !read.row || !owner || !writable) return
    const row = statementEdit(read.row, owner, loaded)
    // The statement a new card holds is cut before its opening date: the opening moves back to that cut first, then the statement saves.
    if (read.opening) void save.mutateAsync(openingEdit(card, read.opening)).then(() => save.mutate(row, { onSuccess: close }), () => undefined)
    else save.mutate(row, { onSuccess: close })
  }
  const money = (f: Exclude<Field, 'cut' | 'due' | 'payments_2'>, hint?: string) => (
    <TextField
      ref={ref(f)}
      label={LABELS[f]}
      hint={hint}
      money={{ currency: card.currency }}
      value={draft[f]}
      onChangeText={(text) => set({ [f]: text } as Partial<StatementDraft>)}
      error={read.errors[f] ?? null}
      editable={!sending}
      onSubmitEditing={onSave}
    />
  )
  const cuts = useMemo(() => cutChoices(snapshot, card), [snapshot, card])
  const day = (f: 'cut' | 'due') => {
    const typed = readDay(draft[f])
    const shown = isDay(typed) ? shortDay(typed, locale, true) : null
    const cut = readDay(draft.cut)
    const suggestions = f === 'cut' ? cuts.map((c) => ({ day: c, label: shortDay(c, locale) })) : isDay(cut) ? [{ day: dueDate(card.terms, cut), label: shortDay(dueDate(card.terms, cut), locale) }] : []
    const note = f === 'cut' && read.opening ? `${shown}. ${card.name} then starts in Waypoint on this day, so the statement it holds fits.` : shown
    return (
      <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 150 }}>
        <DateField
          ref={ref(f)}
          label={LABELS[f]}
          value={draft[f]}
          max={f === 'cut' ? snapshot.as_of : undefined}
          onChange={(text) => change((d) => (f === 'cut' ? changeCut(card, d, text) : { ...d, due: text, due_typed: true }))}
          suggestions={suggestions}
          error={read.errors[f] ?? null}
          note={note}
          editable={!sending}
        />
      </View>
    )
  }

  const failure = save.error ? asDataError(save.error) : null
  const showFailure = failure && !(failure.code === 'statement_exists' && read.duplicate)
  const dup = read.duplicate
  const edit = (s: Statement) => router.setParams({ statement: s.id })
  const offNote = !writable ? (source.kind === 'sample' ? 'Samples are read-only. Sign in to enter your own statements.' : offline ? 'Offline: saving is off until Waypoint reaches the server again.' : 'Saving is off until your household loads.') : null
  const reason = offNote ?? blockedBy(read)
  const { scheme } = useTheme()
  const colourOf = useIdentity()
  const both = draft.payments_2 === null ? null : paymentsSum(draft.payments, draft.payments_2, locale, card.currency)
  const pdfOn = usePdfReadEnabled() && writable
  const [fromPdf, setFromPdf] = useState<{ name: string; read: PdfStatement } | null>(null)
  const [pdfProblem, setPdfProblem] = useState<string | null>(null)
  // A statement in another currency fills nothing; any other fills every field, and the check and warnings below judge it.
  const onPdf = (answer: PdfStatement, file: PickedPdf) => {
    const mismatch = pdfMismatch(answer, card)
    setPdfProblem(mismatch)
    setFromPdf(mismatch ? null : { name: file.name, read: answer })
    if (!mismatch) change((d) => draftFromPdf(d, answer, card, locale))
  }

  return (
    <View style={{ gap: SPACE[5] }}>
      <View style={{ gap: SPACE[1] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2] }}>
          <View style={{ width: SWATCH.size, height: SWATCH.size, borderRadius: SWATCH.radius, backgroundColor: identityColor(colourOf(card.id), scheme) }} />
          <Text variant="subhead" tone="text2" style={{ flexShrink: 1 }}>{`${card.name} · ${card.currency}`}</Text>
        </View>
        {loaded ? <Text variant="subhead" tone="text2">{`Editing the statement cut ${shortDay(loaded.cut_date, locale, true)}`}</Text> : null}
      </View>

      {pdfOn ? <PdfFill label="Fill from the statement PDF" read={(file, password) => readStatementPdf(file, password, card.currency)} onRead={onPdf} disabled={sending} /> : null}
      {pdfProblem ? <Banner tone="negative" title="Not filled" body={pdfProblem} /> : null}
      {fromPdf ? <Banner tone="neutral" title={`Filled from ${fromPdf.name}`} body={pdfFilledNote(fromPdf.read)} /> : null}

      <View style={{ gap: SPACE[3] }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[4], rowGap: SPACE[4] }}>
          {day('cut')}
          {day('due')}
        </View>
        {dup ? <Banner tone="caution" title="A statement for this date exists" body="Edit it to change its figures, or change the cut date." action={{ label: 'Edit', onPress: () => edit(dup) }} /> : null}
      </View>

      <Checkbox
        label="Total and minimum only"
        detail="For a statement that prints no breakdown. It saves as Total only, with no parts to check."
        checked={draft.total_only}
        onChange={(total_only) => set({ total_only })}
        disabled={sending}
      />

      {draft.total_only ? null : (
        <View style={{ gap: SPACE[5] }}>
          {money('previous', 'Below zero when the card was in credit.')}
          <View style={{ gap: SPACE[3] }}>
            {money('payments', 'Every payment, refund and other credit, as printed.')}
            {draft.payments_2 === null ? (
              <View style={{ flexDirection: 'row', marginHorizontal: -SPACE[3] }}>
                <Button
                  label="Add a second printed line"
                  icon="plus"
                  variant="plain"
                  size="small"
                  disabled={sending}
                  onPress={() => {
                    set({ payments_2: '' })
                    focusSoon('payments_2')
                  }}
                />
              </View>
            ) : (
              <>
                <TextField
                  ref={ref('payments_2')}
                  label={LABELS.payments_2}
                  money={{ currency: card.currency }}
                  value={draft.payments_2}
                  onChangeText={(text) => set({ payments_2: text })}
                  error={read.errors.payments_2 ?? null}
                  editable={!sending}
                  onSubmitEditing={onSave}
                />
                {both !== null ? (
                  <Text variant="footnote" tone="text2">
                    {'Payments and credits in all: '}
                    <Money minor={both} currency={card.currency} variant="footnote" tone="text" />
                  </Text>
                ) : null}
                <View style={{ flexDirection: 'row', marginHorizontal: -SPACE[3] }}>
                  <Button
                    label="Remove second line"
                    icon="x"
                    variant="plain"
                    size="small"
                    disabled={sending}
                    onPress={() => {
                      set({ payments_2: null })
                      focusSoon('payments')
                    }}
                  />
                </View>
              </>
            )}
          </View>
          {money('charges', 'Purchases and cash advances.')}
          {money('installments', 'Installments billed on this statement.')}
          {money('interest')}
          {money('fees', 'Late fees and other fees.')}
        </View>
      )}

      <View style={{ gap: SPACE[3] }}>
        {money('total')}
        <CheckLine check={read.check} currency={card.currency} />
      </View>
      {money('minimum')}
      {money('available', 'Optional. Below zero when over the limit.')}

      {warnings.length > 0 ? <Warnings warnings={warnings} currency={card.currency} /> : null}
      {/* Beside Save, where the person is when the refusal comes back. */}
      {showFailure ? (
        <Banner
          tone="negative"
          title={ERROR_TITLES[failure.kind]}
          body={statementProblem(failure)}
          detail={failure.technical ?? undefined}
          action={failure.code === 'stale' ? { label: 'Show the latest', onPress: reload } : undefined}
        />
      ) : null}

      <View style={{ gap: SPACE[2] }}>
        <Button label={sending ? 'Saving…' : 'Save'} variant="primary" onPress={onSave} disabled={!writable || sending || read.row === null} />
        {reason ? (
          <Text variant="footnote" tone="text2" style={{ textAlign: 'center' }}>
            {reason}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

const IDENTITY = 'Previous balance − payments and credits + charges + installments + interest + fees'

// The live check under the total: Balances, or Off by the exact difference with both sides of it.
function CheckLine({ check, currency }: { check: Check; currency: string }) {
  let body: ReactNode
  if (check.state === 'total_only') {
    body = <Text variant="footnote" tone="text2">Saved as Total only: the parts are not checked.</Text>
  } else if (check.state === 'waiting') {
    body = <Text variant="footnote" tone="text2">{check.reason === 'parts' ? 'Correct the amounts marked above to check the total.' : `${IDENTITY} should equal the total due.`}</Text>
  } else if (check.state === 'balances') {
    body = (
      <>
        <Pill tone="positive">Balances</Pill>
        <Text variant="footnote" tone="text2">{`${IDENTITY} = total due.`}</Text>
      </>
    )
  } else {
    body = (
      <>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[2] }}>
          <Pill tone="negative">Off by</Pill>
          <Money minor={Math.abs(check.difference_minor)} currency={currency} variant="subhead" style={{ fontWeight: '600' }} />
        </View>
        <Text variant="footnote" tone="text2">
          {`${IDENTITY} = `}
          <Money minor={check.sum_minor} currency={currency} variant="footnote" tone="text2" />
          {'; the total due is '}
          <Money minor={check.total_minor} currency={currency} variant="footnote" tone="text2" />
          {'.'}
        </Text>
      </>
    )
  }
  return (
    <View aria-live="polite" style={{ gap: SPACE[1] }}>
      {body}
    </View>
  )
}

// Core's statement checks on what is typed: each printed part beside what the household's data expects. They never stop Save.
function Warnings({ warnings, currency }: { warnings: readonly DraftWarning[]; currency: string }) {
  return (
    <Card style={{ gap: SPACE[3] }}>
      {warnings.map((w) => (
        <View key={w.kind} style={{ gap: SPACE[1] }}>
          <Pill tone="caution">{w.word}</Pill>
          <Text variant="footnote" tone="text2">
            {'Printed '}
            <Money minor={w.printed_minor} currency={currency} variant="footnote" tone="text2" />
            {`; ${EXPECTED[w.kind]} `}
            <Money minor={w.expected_minor} currency={currency} variant="footnote" tone="text2" />
            {'.'}
          </Text>
        </View>
      ))}
      <Text variant="footnote" tone="text2">
        These do not stop Save.
      </Text>
    </Card>
  )
}
