import { householdRow, type Household, type Snapshot } from '@waypoint/core'
import { useRouter, type Href } from 'expo-router'
import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react'
import { View, type TextInput } from 'react-native'
import { readMaskAtOpen, rememberAppearance, rememberMaskAtOpen } from '@/data/device'
import { HOUSEHOLD_VALUES } from '@/data/edits'
import { asDataError, DataError, ERROR_TITLES } from '@/data/errors'
import { useSnapshot } from '@/data/hooks'
import { signOut } from '@/data/signout'
import { useDataSource } from '@/data/source'
import { useEdit } from '@/data/useEdit'
import { randomId } from '@/data/uuid'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Checkbox } from '@/ui/Checkbox'
import { Choices } from '@/ui/Choices'
import { EmptyState } from '@/ui/EmptyState'
import { Money } from '@/ui/Money'
import { Row } from '@/ui/Row'
import { useIdentity } from '@/ui/useIdentity'
import { AccountTile } from '@/ui/AccountTile'
import { Segmented } from '@/ui/Segmented'
import { SelectField } from '@/ui/SelectField'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { TextField } from '@/ui/TextField'
import type { Appearance } from '@/ui/appearance'
import { useAppearance, useLocale } from '@/ui/theme'
import { GUTTER, SPACE } from '@/ui/tokens'
import { useZodForm } from '@/ui/useZodForm'
import {
  accountLink,
  accountSections,
  addCategory,
  appearanceControl,
  archiveCategory,
  budgetLink,
  categoryLines,
  householdDraft,
  itemLink,
  canonicalLocale,
  localeChoices,
  localeName,
  localeSample,
  newAccountLink,
  PAYOFF_ORDER,
  PAYOFF_WORDS,
  readCategoryName,
  readHousehold,
  renameCategory,
  saveHousehold,
  zoneSample,
  type HouseholdDraft,
  type HouseholdField,
  type PayoffOrder,
} from './settings.model'
import { exportDetail, useExport } from './useExport'

// Spec §7 Settings: the household, its accounts and categories, what this device does when the app opens, the household's data, and signing out.
export function SettingsBody() {
  const { snapshot } = useSnapshot()
  if (!snapshot) return null
  return (
    <View style={{ gap: SPACE[10] }}>
      <HouseholdSection snapshot={snapshot} />
      <AccountsSection snapshot={snapshot} />
      <CategoriesSection snapshot={snapshot} />
      <DeviceSection />
      <DataSection />
    </View>
  )
}

function SectionTitle({ title, action }: { title: string; action?: { label: string; onPress: () => void } }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: SPACE[3], rowGap: SPACE[1] }}>
      <Text variant="title2" level={2}>
        {title}
      </Text>
      {action ? (
        <View style={{ marginRight: -GUTTER }}>
          <Button label={action.label} icon="plus" variant="plain" onPress={action.onPress} />
        </View>
      ) : null}
    </View>
  )
}

const Note = ({ children }: { children: ReactNode }) => (
  <Text variant="footnote" tone="text2">
    {children}
  </Text>
)

const GroupTitle = ({ children }: { children: string }) => (
  <Text variant="footnote" tone="text2" style={{ fontWeight: '600' }}>
    {children}
  </Text>
)

// Why Save is off, in the words the other editors use.
function useOffNote(): string | null {
  const { writable, source, offline } = useSnapshot()
  if (writable) return null
  if (source.kind === 'sample') return 'Samples are read-only. Sign in to change your own settings.'
  return offline ? 'Offline: saving is off until Waypoint reaches the server again.' : 'Saving is off until your household loads.'
}

// The household's settings, saved together; a reload with new values starts the form again from them.
function HouseholdSection({ snapshot }: { snapshot: Snapshot }) {
  const loaded = snapshot.doc.household
  const edit = useEdit()
  const key = HOUSEHOLD_VALUES.map((c) => loaded[c]).join('|')
  return (
    <View style={{ gap: SPACE[4] }}>
      <SectionTitle title="Household" />
      <HouseholdForm key={key} loaded={loaded} asOf={snapshot.as_of} edit={edit} />
    </View>
  )
}

function HouseholdForm({ loaded, asOf, edit }: { loaded: Household; asOf: string; edit: ReturnType<typeof useEdit> }) {
  const { writable } = useSnapshot()
  const { owner } = useDataSource()
  const locale = useLocale()
  const offNote = useOffNote()
  const [initial] = useState(() => householdDraft(loaded))
  const read = useCallback((d: HouseholdDraft) => readHousehold(d, loaded), [loaded])
  const form = useZodForm<HouseholdDraft, Household, HouseholdField>({ schema: householdRow, initial, read })
  const { draft } = form
  const busy = edit.isPending
  const locked = busy || !writable || owner === null
  const dirty = (Object.keys(initial) as (keyof HouseholdDraft)[]).some((k) => draft[k] !== initial[k])
  const failure = edit.error ? asDataError(edit.error) : null
  const change = (patch: Partial<HouseholdDraft>) => {
    form.set(patch)
    if (edit.error || edit.isSuccess) edit.reset()
  }
  const onSave = () => {
    const row = form.attempt()
    if (!row || locked || owner === null) return
    const save = saveHousehold(owner, loaded, row)
    if (save) edit.mutate(save)
  }
  const { errors } = form
  const [picking, setPicking] = useState(false)
  return (
    <View style={{ gap: SPACE[5] }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[4], rowGap: SPACE[5] }}>
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200 }}>
          <TextField
            label="Base currency"
            hint="Totals across currencies are shown in it, as approximate."
            value={draft.currency}
            onChangeText={(currency) => change({ currency })}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={3}
            numbers
            error={errors.base_currency ?? null}
            editable={!locked}
          />
        </View>
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200 }}>
          <TextField
            label="Time zone"
            hint="Today and every month are counted in it."
            value={draft.timezone}
            onChangeText={(timezone) => change({ timezone })}
            autoCapitalize="none"
            autoCorrect={false}
            error={errors.timezone ?? null}
            note={zoneSample(draft.timezone, locale, new Date())}
            editable={!locked}
          />
        </View>
      </View>
      <SelectField
        label="Language and region"
        hint="How amounts and dates are written, on every device."
        value={localeName(draft.locale)}
        placeholder="Pick one"
        note={localeSample(draft.locale, asOf) || null}
        error={errors.locale ?? null}
        onPress={() => setPicking(true)}
      />
      <Sheet open={picking} onClose={() => setPicking(false)} title="Language and region">
        <Choices label="Language and region" groups={[{ choices: localeChoices(draft.locale, asOf) }]} value={canonicalLocale(draft.locale)} onChange={(tag) => !locked && change({ locale: tag })} onPress={() => setPicking(false)} />
      </Sheet>
      <View style={{ gap: SPACE[2] }}>
        <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
          Payoff order
        </Text>
        <Choices<PayoffOrder>
          label="Payoff order"
          groups={[{ choices: PAYOFF_ORDER.map((p) => ({ value: p, title: PAYOFF_WORDS[p].title, detail: PAYOFF_WORDS[p].detail })) }]}
          value={draft.payoff_order}
          onChange={(payoff_order) => !locked && change({ payoff_order })}
        />
      </View>
      <View style={{ gap: SPACE[2] }}>
        {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
        <View style={{ flexDirection: 'row' }}>
          <Button label={busy ? 'Saving…' : 'Save'} variant="primary" onPress={onSave} disabled={locked || !dirty} />
        </View>
        {offNote ? <Note>{offNote}</Note> : !form.result.ok && Object.keys(errors).length > 0 ? <Note>Correct the fields marked above.</Note> : edit.isSuccess && !dirty ? <Note>Saved.</Note> : null}
      </View>
    </View>
  )
}

function AccountsSection({ snapshot }: { snapshot: Snapshot }) {
  const router = useRouter()
  const sections = accountSections(snapshot)
  // The order here sets each account's colour, so each row shows it.
  const colourOf = useIdentity()
  const add = () => router.push(newAccountLink('cash'))
  return (
    <View style={{ gap: SPACE[4] }}>
      <SectionTitle title="Accounts" action={{ label: 'Add an account', onPress: add }} />
      {sections.length === 0 ? (
        <Card>
          <EmptyState title="No accounts yet" body="Add the accounts that hold your money and the cards and loans that owe it." action={{ label: 'Add an account', onPress: add }} />
        </Card>
      ) : (
        sections.map((s) => (
          <View key={s.title} style={{ gap: SPACE[2] }}>
            <GroupTitle>{s.title}</GroupTitle>
            <Card flush>
              {s.accounts.map((a, i) => (
                <Row key={a.id} divider={i > 0} leading={<AccountTile name={a.name} colour={colourOf(a.id)} />} title={a.name} detail={a.detail} onPress={() => router.push(accountLink(a.id))} />
              ))}
            </Card>
          </View>
        ))
      )}
    </View>
  )
}

interface SheetState {
  open: boolean
  // The category shown; null while a new one is being named.
  id: string | null
  // Where to go once the sheet has closed.
  then: Href | null
}

function CategoriesSection({ snapshot }: { snapshot: Snapshot }) {
  const router = useRouter()
  const lines = categoryLines(snapshot)
  const [sheet, setSheet] = useState<SheetState>({ open: false, id: null, then: null })
  // Each opening starts the form afresh, and a new category gets a new id, so a retry of one Add never adds two.
  const [round, setRound] = useState(0)
  const [newId, setNewId] = useState(() => randomId())
  const open = (id: string | null) => {
    setRound((r) => r + 1)
    if (id === null) setNewId(randomId())
    setSheet({ open: true, id, then: null })
  }
  // The sheet closes first, then the next page opens, so the sheet never sits over it.
  const leave = (then: Href) => setSheet((s) => ({ ...s, open: false, then }))
  const onExited = () => {
    if (sheet.then) router.push(sheet.then)
  }
  const id = sheet.id ?? newId
  const shown = snapshot.doc.categories.find((c) => c.id === id)
  const field = useRef<TextInput>(null)
  return (
    <View style={{ gap: SPACE[4] }}>
      <SectionTitle title="Categories" action={{ label: 'Add a category', onPress: () => open(null) }} />
      {lines.length === 0 ? (
        <Card>
          <EmptyState title="No categories yet" body="A category tags what you spend, and a monthly budget for it shows on Today." action={{ label: 'Add a category', onPress: () => open(null) }} />
        </Card>
      ) : (
        <Card flush>
          {lines.map((c, i) => (
            <Row
              key={c.id}
              divider={i > 0}
              title={c.name}
              detail={[c.budget ? `Monthly budget from ${c.budget.from}` : 'No monthly budget', c.archived ? 'Archived' : null].filter(Boolean).join(' · ')}
              trailing={c.budget ? <Money minor={c.budget.amount_minor} currency={c.budget.currency} variant="subhead" tone="text2" /> : undefined}
              onPress={() => open(c.id)}
            />
          ))}
        </Card>
      )}
      {/* Mounted always, so the sheet knows the motion setting before it first opens. */}
      <Sheet open={sheet.open} onClose={() => setSheet((s) => ({ ...s, open: false }))} onExited={onExited} title={shown ? shown.name : 'New category'} initialFocus={sheet.id === null ? field : undefined}>
        <CategoryForm key={round} snapshot={snapshot} id={id} field={field} leave={leave} />
      </Sheet>
    </View>
  )
}

interface CategoryFormProps {
  snapshot: Snapshot
  id: string
  field: RefObject<TextInput | null>
  leave: (then: Href) => void
}

// Add, rename and archive a category, and from it add or open its monthly budget in the plan item editor.
function CategoryForm({ snapshot, id, field, leave }: CategoryFormProps) {
  const { writable } = useSnapshot()
  const { owner } = useDataSource()
  const offNote = useOffNote()
  const edit = useEdit()
  const loaded = snapshot.doc.categories.find((c) => c.id === id) ?? null
  const [name, setName] = useState(loaded?.name ?? '')
  const [tried, setTried] = useState(false)
  const busy = edit.isPending
  const locked = busy || !writable || owner === null
  const read = readCategoryName(snapshot, name, loaded?.id ?? null)
  const failure = edit.error ? asDataError(edit.error) : null
  const nameError = tried && 'error' in read ? read.error : failure?.code === 'category_exists' ? failure.message : null
  const onSave = () => {
    setTried(true)
    if (locked || owner === null || 'error' in read) return
    if (!loaded) return edit.mutate(addCategory(id, read.name, owner))
    const rename = renameCategory(loaded, read.name)
    if (rename) edit.mutate(rename)
  }
  const budget = loaded ? (categoryLines(snapshot).find((c) => c.id === loaded.id)?.budget ?? null) : null
  return (
    <View style={{ gap: SPACE[4] }}>
      <TextField
        ref={field}
        label="Name"
        value={name}
        onChangeText={(text) => {
          setName(text)
          if (edit.error) edit.reset()
        }}
        maxLength={40}
        autoCapitalize="sentences"
        error={nameError}
        editable={!locked}
        onSubmitEditing={onSave}
      />
      {failure && failure.code !== 'category_exists' ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
      <View style={{ gap: SPACE[2] }}>
        <View style={{ flexDirection: 'row' }}>
          <Button label={busy ? 'Saving…' : loaded ? 'Save name' : 'Add category'} variant={loaded ? 'tonal' : 'primary'} onPress={onSave} disabled={locked || (loaded !== null && name.trim() === loaded.name)} />
        </View>
        {offNote ? <Note>{offNote}</Note> : null}
      </View>
      {loaded ? (
        <View style={{ gap: SPACE[6] }}>
          <View style={{ gap: SPACE[2] }}>
            <Text variant="headline">Monthly budget</Text>
            {budget ? (
              <>
                <Text tone="text2">
                  <Money minor={budget.amount_minor} currency={budget.currency} tone="text2" />
                  {` a month from ${budget.from}.`}
                </Text>
                <View style={{ flexDirection: 'row' }}>
                  <Button label="Open the budget" onPress={() => leave(itemLink(budget.item_id))} />
                </View>
              </>
            ) : (
              <>
                <Note>{`A monthly budget counts spending tagged ${loaded.name} against an amount, and Today shows its pace.`}</Note>
                <View style={{ flexDirection: 'row' }}>
                  <Button label="Add a monthly budget" variant="primary" onPress={() => leave(budgetLink(loaded.id))} disabled={!writable} />
                </View>
              </>
            )}
          </View>
          <View style={{ gap: SPACE[1] }}>
            <View style={{ flexDirection: 'row', marginLeft: -SPACE[3] }}>
              <Button label={loaded.archived_at === null ? 'Archive' : 'Unarchive'} variant="plain" size="small" onPress={() => edit.mutate(archiveCategory(loaded, loaded.archived_at === null ? new Date().toISOString() : null))} disabled={locked} />
            </View>
            <Note>{loaded.archived_at === null ? 'An archived category leaves the pickers; spending already tagged with it keeps the tag.' : 'Archived: pickers leave it out. Unarchive it to use it again.'}</Note>
          </View>
        </View>
      ) : null}
    </View>
  )
}

// Per device: light or dark, and whether amounts open hidden, as the eye in the header hides them.
function DeviceSection() {
  const { appearance, setAppearance } = useAppearance()
  const look = appearanceControl(appearance)
  const [on, setOn] = useState(readMaskAtOpen)
  const [kept, setKept] = useState(true)
  return (
    <View style={{ gap: SPACE[4] }}>
      <SectionTitle title="This device" />
      <View style={{ gap: SPACE[2] }}>
        <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
          Appearance
        </Text>
        <Segmented<Appearance>
          label="Appearance"
          options={look.options}
          value={look.value}
          onChange={(next) => {
            setKept(rememberAppearance(next))
            setAppearance(next)
          }}
        />
        <Note>System follows the device’s light or dark setting.</Note>
      </View>
      <View style={{ gap: SPACE[1] }}>
        <Checkbox
          label="Mask amounts when the app opens"
          detail="Amounts stay hidden until you tap the eye. Only this device changes."
          checked={on}
          onChange={(next) => {
            setKept(rememberMaskAtOpen(next))
            setOn(next)
          }}
        />
        {kept ? null : <Note>This browser does not keep settings, so it cannot remember this.</Note>}
      </View>
    </View>
  )
}

function DataSection() {
  const router = useRouter()
  const { owner, source } = useDataSource()
  const [problem, setProblem] = useState<DataError | null>(null)
  const exported = useExport()
  // A sample is built on this device and saved nowhere, so there is nothing of the person's to export.
  const own = owner !== null && source.kind === 'supabase'
  const failed = exported.state.kind === 'failed' ? exported.state.error : null
  return (
    <View style={{ gap: SPACE[4] }}>
      <SectionTitle title="Your data" />
      <Card flush>
        <Row title="Import a CSV file" detail="Bank transactions into one account." onPress={() => router.push('/import')} />
        <Row divider title="Export data" detail={own ? exportDetail(exported.state) : 'Samples are saved nowhere, so they have nothing to export.'} onPress={own ? exported.run : undefined} />
        <Row divider title="Delete account" detail="Your sign-in and your household with everything in it, for good." onPress={() => router.push('/delete-account')} />
      </Card>
      {failed ? <Banner tone="negative" title={failed.kind === 'network' ? ERROR_TITLES.network : 'Not exported'} body={failed.message} detail={failed.technical ?? undefined} /> : null}
      {/* Signing out goes back to Welcome; the gate does the moving. */}
      {owner !== null ? (
        <View style={{ flexDirection: 'row' }}>
          <Button label="Sign out" onPress={() => void signOut().then(setProblem)} />
        </View>
      ) : null}
      {problem ? <Banner tone="negative" title="Not signed out" body={problem.message} detail={problem.technical ?? undefined} /> : null}
    </View>
  )
}
