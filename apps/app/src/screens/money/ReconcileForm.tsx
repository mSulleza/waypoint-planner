import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Platform, View, type TextInput } from 'react-native'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { usePostBatch, useSnapshot } from '@/data/hooks'
import { shortDay } from '@/data/status'
import { randomId } from '@/data/uuid'
import { useCloseSheet } from '@/shell/RouteSheet'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Money } from '@/ui/Money'
import { Pill } from '@/ui/Pill'
import { Text } from '@/ui/Text'
import { TextField } from '@/ui/TextField'
import { useLocale, useTheme } from '@/ui/theme'
import { useMaskText } from '@/ui/useMaskText'
import { GUTTER, LINE_WIDTH, SPACE } from '@/ui/tokens'
import { adjustmentBatch, adjustmentProblem, missingParams, reconcileView, RECENT_DAYS } from './reconcile.model'

export interface ReconcileFormProps {
  // The Bank says field, which the sheet focuses on open.
  focus: RefObject<{ focus: () => void } | null>
}

// Spec §7 Reconcile: the bank's figure against the ledger to today, live as it is typed. Nothing is written until a button is pressed (invariant 24).
export function ReconcileForm({ focus }: ReconcileFormProps) {
  const { account: accountId } = useLocalSearchParams<{ account?: string }>()
  const { snapshot, writable, source, offline } = useSnapshot()
  const locale = useLocale()
  const router = useRouter()
  const close = useCloseSheet()
  const save = usePostBatch()
  const [bank, setBank] = useState('')
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  // Made once per opening, so a retry after a lost reply saves once.
  const [ids] = useState(() => ({ batch_id: randomId(), row_id: randomId() }))
  const view = useMemo(() => (snapshot && accountId ? reconcileView(snapshot, accountId, bank, locale) : null), [snapshot, accountId, bank, locale])
  const input = useRef<TextInput>(null)
  useEffect(() => {
    focus.current = { focus: () => input.current?.focus() }
    // The form can draw after the sheet opened (its code loads apart), so it takes the focus itself; a timer, as a background tab draws no frames.
    if (Platform.OS !== 'web') return
    const timer = setTimeout(() => input.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [focus])
  if (!snapshot) return null
  if (!view) return <Text tone="text2">This household has no account at this link.</Text>

  const { account, debt, gap_minor: gap } = view
  const currency = account.currency
  // A debt's figures read as what is owed, positive.
  const shown = (balance: number) => (debt ? -balance : balance)
  const unreadable = bank.trim() !== '' && view.bank_minor === null
  const missing = missingParams(view)
  const off = writable ? null : source.kind === 'sample' ? 'Samples are read-only. Sign in to reconcile your own accounts.' : offline ? 'Waypoint is offline. Saving comes back once it reaches the server.' : 'Your household is still loading.'

  const post = () => {
    const read = adjustmentBatch(snapshot, view, note, ids)
    if (!read.ok) return setProblem(read.error)
    setProblem(null)
    save.mutate(read.batch, { onSuccess: close })
  }
  const failure = save.error ? asDataError(save.error) : null
  const refusal = failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={adjustmentProblem(failure)} detail={failure.technical ?? undefined} /> : null
  // The refusal sits by Post adjustment, where the person's eye is; with the gap now closed, at the top.
  const nearButton = gap !== null && gap !== 0
  return (
    <View style={{ gap: SPACE[4] }}>
      {nearButton ? null : refusal}
      <Text variant="subhead" tone="text2">{`${account.name} · ${currency}`}</Text>
      <TextField
        ref={input}
        label={debt ? 'Bank says you owe' : 'Bank says'}
        hint={debt ? 'The balance the bank shows now, with pending charges in.' : 'The available balance, which takes off pending charges. Add back money held in pots or sub-accounts.'}
        money={{ currency }}
        value={bank}
        onChangeText={(text) => {
          setBank(text)
          setProblem(null)
        }}
        error={unreadable ? 'Enter the amount as the bank shows it.' : null}
      />
      <Card style={{ gap: SPACE[3] }}>
        <Fact label={debt ? 'Waypoint says you owe' : 'Waypoint to today'} note={`Opening balance plus every transaction to ${shortDay(snapshot.as_of, locale)}.`}>
          <Money minor={shown(view.ledger_minor)} currency={currency} owed={debt} variant="headline" />
        </Fact>
        <Fact label="Gap">
          {gap === null ? (
            <Text tone="text2">Enter what the bank says.</Text>
          ) : gap === 0 ? (
            <Pill tone="positive">Matches the bank</Pill>
          ) : (
            <>
              {/* The bank's figure minus Waypoint's, in the terms shown above: what is owed, for a debt. */}
              <Money minor={shown(gap)} currency={currency} signed variant="headline" />
              <Text variant="footnote" tone="text2">
                {'The bank shows '}
                <Money minor={Math.abs(gap)} currency={currency} variant="footnote" tone="text2" />
                {debt ? (gap < 0 ? ' more owed than Waypoint.' : ' less owed than Waypoint.') : gap > 0 ? ' more than Waypoint.' : ' less than Waypoint.'}
              </Text>
            </>
          )}
        </Fact>
      </Card>
      {gap !== null && gap !== 0 ? (
        <>
          {/* Invariant 25: a charge can post days after it was made, so the gap is checked before anything is called missing. */}
          <Banner tone="neutral" title="Check before you add" body="Charges can post days after you pay. Look at the bank’s pending list and the transactions below before you call one missing." />
          <Recent view={view} />
          {off ? <Banner tone="neutral" title="Saving is off" body={off} /> : null}
          {missing ? (
            <Button
              label="Add missing transaction"
              variant="primary"
              onPress={() => router.replace({ pathname: '/add', params: missing.mode === 'in' ? { mode: 'in', to: missing.to, amount: missing.amount } : { mode: 'out', from: missing.from, amount: missing.amount } })}
            />
          ) : null}
          <View style={{ gap: SPACE[2] }}>
            <TextField
              label="Adjustment note"
              hint="Only for a difference you cannot trace. An adjustment changes the balance with no transaction behind it."
              value={note}
              onChangeText={(text) => {
                setNote(text)
                setProblem(null)
              }}
              maxLength={140}
              error={problem}
            />
            {refusal}
            <Button label={save.isPending ? 'Posting…' : 'Post adjustment'} disabled={save.isPending || !writable} onPress={post} />
          </View>
        </>
      ) : null}
    </View>
  )
}

function Fact({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <View style={{ gap: SPACE[1] }}>
      <Text variant="footnote" tone="text2">
        {label}
      </Text>
      {children}
      {note ? (
        <Text variant="footnote" tone="text2">
          {note}
        </Text>
      ) : null}
    </View>
  )
}

// The last 7 days' rows with no link to the plan: a charge entered twice or at the wrong amount shows up here.
function Recent({ view }: { view: NonNullable<ReturnType<typeof reconcileView>> }) {
  const { colors } = useTheme()
  const locale = useLocale()
  const text = useMaskText()
  const since = shortDay(view.since, locale)
  return (
    <View style={{ gap: SPACE[2] }}>
      <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
        {`Last ${RECENT_DAYS} days, not linked to your plan`}
      </Text>
      {view.recent.length === 0 ? (
        <Text variant="footnote" tone="text2">{`Nothing unlinked on ${view.account.name} since ${since}.`}</Text>
      ) : (
        <Card flush>
          {view.recent.map((line, i) => (
            <View key={line.id} style={{ paddingHorizontal: GUTTER, paddingVertical: SPACE[3], flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3] }}>
              {i > 0 ? <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} /> : null}
              <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
                <Text>{text(line.title)}</Text>
                <Text variant="footnote" tone="text2">
                  {[shortDay(line.posted_on, locale), line.detail].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <Money minor={line.amount_minor} currency={view.account.currency} signed />
            </View>
          ))}
        </Card>
      )}
    </View>
  )
}
