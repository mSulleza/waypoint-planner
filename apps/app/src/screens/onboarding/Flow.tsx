import { todayIn } from '@waypoint/core'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { View, type TextInput } from 'react-native'
import { useImportHousehold } from '@/data/hooks'
import { asDataError, type DataError } from '@/data/errors'
import {
  cardCurrency,
  firstStepWithError,
  initialDraft,
  monthlyPayday,
  paydayChoices,
  presetGroups,
  readCurrency,
  readDraft,
  readTimeZone,
  STEP_COUNT,
  stepErrors,
  type DebtKind,
  type Draft,
  type ErrorKey,
  type Errors,
  type Every,
  type Pays,
} from '@/screens/onboarding/onboarding.model'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Choices } from '@/ui/Choices'
import { Segmented } from '@/ui/Segmented'
import { Text } from '@/ui/Text'
import { FieldError, TextField, type TextFieldProps } from '@/ui/TextField'
import { useLocale, useTheme } from '@/ui/theme'
import { SPACE } from '@/ui/tokens'

type TextKey = Exclude<keyof Draft, 'every' | 'debt' | 'preset' | 'payday_date' | 'pays'>

const ERROR_OF: Partial<Record<TextKey, ErrorKey>> = { payday_day: 'payday' }
const errorKey = (key: TextKey): ErrorKey => ERROR_OF[key] ?? (key as ErrorKey)

const TITLES = ['Currency and time zone', 'Main account', 'Income', 'Living costs', 'A card or loan']

const EVERY: readonly { value: Every; label: string; accessibilityLabel?: string }[] = [
  { value: 'month', label: 'Monthly' },
  { value: '2weeks', label: '2 weeks', accessibilityLabel: 'Every 2 weeks' },
  { value: 'week', label: 'Weekly' },
]

// What the plan pays on the card each month: the minimum alone never clears a balance that earns interest.
const PAYS: readonly { value: Exclude<Pays, ''>; title: string; detail: string }[] = [
  { value: 'minimum', title: 'The minimum', detail: 'What the bank asks for by its rules. Interest builds on the rest.' },
  { value: 'full', title: 'The full statement', detail: 'The whole balance each month, so no interest is charged.' },
  { value: 'extra', title: 'The minimum and a set extra', detail: 'A fixed amount on top of the minimum each month.' },
]

const DEBTS: readonly { value: DebtKind; label: string }[] = [
  { value: 'none', label: 'Not now' },
  { value: 'card', label: 'Card' },
  { value: 'loan', label: 'Loan' },
]

const utc = (day: string) => new Date(`${day}T00:00:00Z`)

function longDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(utc(day))
}

// A payday chip: the day of the month under its weekday, with the month once it is not this one.
function chipDay(day: string, today: string, locale: string): { title: string; detail: string; label: string } {
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(utc(day))
  const weekday = part({ weekday: 'short' })
  return { title: part({ day: 'numeric' }), detail: day.slice(0, 7) === today.slice(0, 7) ? weekday : `${weekday} · ${part({ month: 'short' })}`, label: longDay(day, locale) }
}

function currencyName(text: string, locale: string): string | null {
  const read = readCurrency(text)
  if ('error' in read) return null
  try {
    return typeof Intl.DisplayNames === 'function' ? (new Intl.DisplayNames([locale], { type: 'currency' }).of(read.code) ?? null) : null
  } catch {
    return null
  }
}

// The step order of the typed answers, for Enter and for the first field to focus.
function fieldsOf(step: number, draft: Draft): TextKey[] {
  if (step === 0) return ['currency', 'timezone']
  if (step === 1) return ['name', 'account_currency', 'balance', 'floor']
  if (step === 2) return draft.every === 'month' ? ['income', 'payday_day'] : ['income']
  if (step === 3) return ['living']
  if (draft.debt === 'card') return draft.pays === 'extra' ? ['owed', 'cut_day', 'due_day', 'extra'] : ['owed', 'cut_day', 'due_day']
  if (draft.debt === 'loan') return ['loan_balance', 'payment', 'rate', 'payment_day']
  return []
}

// Spec §7 onboarding: the five questions, loaded only when an account with no household opens set-up.
export function Flow({ step, setStep }: { step: number; setStep: (step: number) => void }) {
  const locale = useLocale()
  const [draft, setDraft] = useState<Draft>(() => initialDraft(locale, new Intl.DateTimeFormat().resolvedOptions().timeZone))
  const [errors, setErrors] = useState<Errors>({})
  // The field that takes the focus when its step opens: only after a step the person took, never on arrival or when a choice adds fields.
  const [focusKey, setFocusKey] = useState<TextKey | null>(null)
  // The main account follows the household currency until the person changes it.
  const [ownCurrency, setOwnCurrency] = useState(false)
  const refs = useRef<Partial<Record<TextKey, TextInput | null>>>({})
  const save = useImportHousehold()
  const busy = save.isPending
  // A ref, not state: two quick taps on Finish must not send two imports.
  const sending = useRef(false)

  const zone = readTimeZone(draft.timezone)
  const today = todayIn(zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone, new Date())
  const mainCurrency = draft.account_currency.trim().toUpperCase()
  // Every amount field is masked by the eye, whatever its currency reads as so far.
  const money = (currency: string): Partial<TextFieldProps> => ({ money: { currency } })
  const groups = useMemo(() => presetGroups(locale).map((g) => ({ title: g.heading, choices: g.options.map((o) => ({ value: o.id, title: o.title, detail: o.detail })) })), [locale])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const clear = (key: ErrorKey) => setErrors((e) => (key in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== key)) : e))

  const go = (to: number) => {
    setStep(to)
    setFocusKey(fieldsOf(to, draft).find((k) => draft[k].trim() === '') ?? null)
    save.reset()
  }

  const next = () => {
    if (busy || sending.current) return
    const reading = readDraft(draft, locale, new Date())
    const shown = stepErrors(reading.errors, step)
    if (Object.keys(shown).length > 0) {
      setErrors(shown)
      const first = fieldsOf(step, draft).find((k) => errorKey(k) in shown)
      if (first) refs.current[first]?.focus()
      return
    }
    setErrors({})
    if (step === 0 && !ownCurrency) set('account_currency', draft.currency.trim().toUpperCase())
    if (step < STEP_COUNT - 1) return go(step + 1)
    // An earlier answer that no longer reads (a currency changed after its amounts) sends the person back to it.
    const back = firstStepWithError(reading.errors)
    if (back !== null || !reading.doc) {
      if (back !== null && back !== step) go(back)
      setErrors(reading.errors)
      return
    }
    sending.current = true
    save.mutate(reading.doc, { onSettled: () => (sending.current = false) })
  }

  const field = (key: TextKey, label: string, more: Partial<TextFieldProps> = {}): TextFieldProps => {
    const order = fieldsOf(step, draft)
    const after = order[order.indexOf(key) + 1]
    return {
      label,
      value: draft[key],
      onChangeText: (text: string) => {
        set(key, text)
        clear(errorKey(key))
        if (key === 'account_currency') setOwnCurrency(true)
      },
      error: errors[errorKey(key)] ?? null,
      ref: (r: TextInput | null) => {
        refs.current[key] = r
      },
      autoFocus: focusKey === key,
      enterKeyHint: after ? 'next' : step === STEP_COUNT - 1 ? 'done' : 'next',
      onSubmitEditing: () => (after ? refs.current[after]?.focus() : next()),
      editable: !busy,
      ...more,
    }
  }
  const day = (key: TextKey, label: string, more: Partial<TextFieldProps> = {}) => field(key, label, { inputMode: 'numeric', maxLength: 2, ...more })
  const code = (key: TextKey, label: string) => field(key, label, { autoCapitalize: 'characters', autoCorrect: false, upper: true, numbers: true, note: currencyName(draft[key], locale) })

  const paydayDay = /^\s*\d{1,2}\s*$/.test(draft.payday_day) ? Number(draft.payday_day) : 0
  const paydayNote = paydayDay >= 1 && paydayDay <= 31 ? `Next payday: ${longDay(monthlyPayday(today, paydayDay).next, locale)}` : null

  const pickEvery = (every: Every) => {
    set('every', every)
    clear('payday')
    if (every !== 'month' && !paydayChoices(today, every).includes(draft.payday_date)) set('payday_date', '')
  }

  const body = (): ReactNode => {
    switch (step) {
      case 0:
        return (
          <Card>
            <TextField {...code('currency', 'Currency')} hint="Three letters, such as EUR or USD. Totals across accounts show in it." />
            <TextField {...field('timezone', 'Time zone', { autoCapitalize: 'none', autoCorrect: false, note: zone ? `It is ${longDay(today, locale)} there.` : null })} hint="Sets when each day starts." />
          </Card>
        )
      case 1:
        return (
          <Card>
            <TextField {...field('name', 'Name', { maxLength: 40, autoCapitalize: 'words' })} />
            <TextField {...code('account_currency', 'Currency')} />
            <TextField {...field('balance', 'Balance today', money(mainCurrency))} />
            <TextField {...field('floor', 'Lowest balance to keep', { ...money(mainCurrency), placeholder: '0' })} hint="Waypoint warns you about any day it would go below this. Leave it empty for none." />
          </Card>
        )
      case 2:
        return (
          <Card>
            <TextField {...field('income', 'Pay after tax', money(mainCurrency))} hint="What lands in the account each payday." />
            <View style={{ gap: SPACE[1] }}>
              <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
                How often
              </Text>
              <Segmented options={EVERY} value={draft.every} onChange={pickEvery} label="How often" />
            </View>
            {draft.every === 'month' ? (
              <TextField {...day('payday_day', 'Payday', { note: paydayNote })} hint="Day of the month, 1 to 31." />
            ) : (
              <View style={{ gap: SPACE[2] }}>
                <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
                  Next payday
                </Text>
                <Choices
                  layout="chips"
                  label="Next payday"
                  groups={[{ choices: paydayChoices(today, draft.every).map((d) => ({ value: d, ...chipDay(d, today, locale) })) }]}
                  value={draft.payday_date || null}
                  onChange={(d) => {
                    set('payday_date', d)
                    clear('payday')
                  }}
                />
                {errors.payday ? <FieldError text={errors.payday} /> : null}
              </View>
            )}
          </Card>
        )
      case 3:
        return (
          <Card>
            <TextField {...field('living', 'Each month', money(mainCurrency))} hint="Rent, food, bills and everything else you spend. This month’s full amount is spread over the days left." />
          </Card>
        )
      default:
        return (
          <View style={{ gap: SPACE[4] }}>
            <Segmented options={DEBTS} value={draft.debt} onChange={(d) => set('debt', d)} label="Add a card or loan" />
            {draft.debt === 'card' ? (
              <>
                <View style={{ gap: SPACE[2] }}>
                  <View style={{ gap: SPACE[1] }}>
                    <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
                      How the card works
                    </Text>
                    <Text variant="footnote" tone="text2">
                      Not sure? Pick Any bank.
                    </Text>
                  </View>
                  <Choices label="How the card works" groups={groups} value={draft.preset} onChange={(p) => set('preset', p)} />
                </View>
                <Card>
                  <TextField {...field('owed', 'Owed today', money(cardCurrency(draft.preset, mainCurrency)))} />
                  <Pair>
                    <TextField {...day('cut_day', 'Statement day')} />
                    <TextField {...day('due_day', 'Due day')} />
                  </Pair>
                </Card>
                <View style={{ gap: SPACE[2] }}>
                  <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
                    Each month I pay
                  </Text>
                  <Choices
                    label="Each month I pay"
                    groups={[{ choices: PAYS }]}
                    value={draft.pays || null}
                    onChange={(pays) => {
                      set('pays', pays)
                      clear('pays')
                    }}
                  />
                  {errors.pays ? <FieldError text={errors.pays} /> : null}
                  {draft.pays === 'extra' ? (
                    <Card>
                      <TextField {...field('extra', 'Extra each month', money(cardCurrency(draft.preset, mainCurrency)))} hint="Paid with the minimum, from your main account." />
                    </Card>
                  ) : null}
                </View>
              </>
            ) : null}
            {draft.debt === 'loan' ? (
              <Card>
                <TextField {...field('loan_balance', 'Balance owed', money(mainCurrency))} />
                <TextField {...field('payment', 'Monthly payment', money(mainCurrency))} />
                <Pair>
                  <TextField {...field('rate', 'Yearly rate', { inputMode: 'decimal', suffix: '%' })} />
                  <TextField {...day('payment_day', 'Payment day')} />
                </Pair>
              </Card>
            ) : null}
          </View>
        )
    }
  }

  const notes = [
    'Five questions to your first projection. You can change every answer later.',
    'The account your pay lands in and your spending leaves from.',
    `What you are paid into ${draft.name.trim() || 'your main account'}.`,
    'Waypoint spreads this evenly over each month.',
    `Optional. Paid from ${draft.name.trim() || 'your main account'}; add more later in Debts.`,
  ]

  const failed: DataError | null = save.error ? asDataError(save.error) : null
  return (
    <View style={{ gap: SPACE[6] }}>
      <Progress step={step} />
      <View key={step} style={{ gap: SPACE[4] }}>
        <View style={{ gap: SPACE[1] }}>
          <Text variant="title2" level={2}>
            {TITLES[step]}
          </Text>
          <Text variant="subhead" tone="text2">
            {notes[step]}
          </Text>
        </View>
        {body()}
      </View>
      {errors.doc ? <Banner tone="negative" title="Not set up" body="These answers did not pass the checks, so nothing was saved." detail={errors.doc} /> : null}
      {failed ? <Banner tone="negative" title="Not set up" body={`${failed.message} Nothing was saved.`} detail={failed.technical ?? undefined} /> : null}
      <View style={{ flexDirection: 'row', gap: SPACE[3] }}>
        {step > 0 ? <Button label="Back" icon="arrow-left" onPress={() => go(step - 1)} disabled={busy} /> : null}
        <View style={{ flex: 1 }}>
          <Button label={step < STEP_COUNT - 1 ? 'Next' : busy ? 'Setting up…' : 'Finish'} variant="primary" onPress={next} disabled={busy} />
        </View>
      </View>
    </View>
  )
}

function Progress({ step }: { step: number }) {
  const { colors } = useTheme()
  return (
    <View style={{ gap: SPACE[2] }}>
      <Text variant="footnote" tone="text2" numbers>
        {`Question ${step + 1} of ${STEP_COUNT}`}
      </Text>
      <View aria-hidden style={{ flexDirection: 'row', gap: SPACE[1] }}>
        {Array.from({ length: STEP_COUNT }, (_, i) => (
          <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i <= step ? colors.brandText : colors.line }} />
        ))}
      </View>
    </View>
  )
}

// Two short fields side by side, stacking when the column is narrow.
function Pair({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[3] }}>{Array.isArray(children) ? children.map((c, i) => <View key={i} style={{ flexGrow: 1, flexBasis: 120 }}>{c}</View>) : children}</View>
}
