import { useQuery } from '@tanstack/react-query'
import { snapshotIndex, type Account, type Category, type Snapshot } from '@waypoint/core'
import { csvDrafts, csvMappingDraft, guessCsvMapping, readCsv, savedMapping, type CsvDraft, type CsvMapping, type CsvMappingDraft, type CsvSkip, type CsvTable } from '@waypoint/core/csv'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, View, type ViewStyle } from 'react-native'
import { pickCsvFile } from '@/data/csv-file'
import { asDataError, ERROR_TITLES } from '@/data/errors'
import { usePostBatch, useSnapshot } from '@/data/hooks'
import { recordedIds, type RecordedRow } from '@/data/imports'
import { useDataSource } from '@/data/source'
import { shortDay } from '@/data/status'
import { getSupabase } from '@/data/supabase'
import { useEdit } from '@/data/useEdit'
import { randomId } from '@/data/uuid'
import { Screen } from '@/shell/Screen'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Checkbox } from '@/ui/Checkbox'
import { Choices } from '@/ui/Choices'
import { maskFigures } from '@/ui/mask-text'
import { Money } from '@/ui/Money'
import { Segmented } from '@/ui/Segmented'
import { SelectField } from '@/ui/SelectField'
import { Sheet } from '@/ui/Sheet'
import { Text } from '@/ui/Text'
import { FieldError } from '@/ui/TextField'
import { useFocusRing, useLocale, useMask, useTheme } from '@/ui/theme'
import { GUTTER, LINE_WIDTH, RADII, ROW_MIN_HEIGHT, SPACE } from '@/ui/tokens'
import {
  choiceOf,
  columnChoices,
  dateOrderChoices,
  fileDays,
  firstValue,
  importAccounts,
  importBatch,
  kindOf,
  mappingChanged,
  previewOf,
  readMapping,
  reviewItems,
  reviewRows,
  reviewSummary,
  skipWords,
  takesCategory,
  type MappingField,
  type ReviewItem,
  type ReviewRow,
  type ReviewSummary,
  type RowChoice,
} from './import.model'

interface LoadedFile {
  name: string
  table: CsvTable
  // Each file gets its own review, with new row ids and a new batch id.
  key: string
}

type Step = { step: 'start'; problem: string | null } | { step: 'columns'; file: LoadedFile; draft: CsvMappingDraft; note: string | null } | { step: 'review'; file: LoadedFile; mapping: CsvMapping }

const KIND_WORDS: Record<Account['kind'], string> = { cash: 'Cash', credit_card: 'Card', loan: 'Loan' }

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

const utc = (day: string) => new Date(`${day}T00:00:00Z`)
const longDay = (day: string, locale: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utc(day))
// An occurrence's period: its month, or its day for a weekly item.
const periodLabel = (period: string, locale: string) => (period.endsWith('-01') ? new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(utc(period)) : shortDay(period, locale))
const rows = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`

// A bank's words, with any figure beside a currency masked under the eye.
function describe(description: string, masked: boolean): string {
  if (description === '') return 'No description'
  return masked ? maskFigures(description) : description
}

// Spec §7 Import: /import?account=<id>. A bank's CSV file is read on the device, its columns mapped once per account, and its rows reviewed, then saved as one batch that Undo deletes.
export function ImportFlow() {
  const { snapshot } = useSnapshot()
  if (!snapshot) return <Screen title="Import" kind="page" />
  return <ImportSteps snapshot={snapshot} />
}

function ImportSteps({ snapshot }: { snapshot: Snapshot }) {
  const params = useLocalSearchParams<{ account?: string }>()
  const router = useRouter()
  const locale = useLocale()
  const accounts = useMemo(() => importAccounts(snapshot), [snapshot])
  const account = accounts.find((a) => a.id === params.account)
  const [step, setStep] = useState<Step>({ step: 'start', problem: null })

  const choose = async () => {
    if (!account) return
    let picked: Awaited<ReturnType<typeof pickCsvFile>>
    try {
      picked = await pickCsvFile()
    } catch {
      return setStep({ step: 'start', problem: 'The file could not be read on this device. Save it again from your bank and choose it once more.' })
    }
    if (!picked) return
    const read = readCsv(picked.text)
    if (!read.ok) return setStep({ step: 'start', problem: read.error })
    const file = { name: picked.name, table: read.table, key: randomId() }
    const saved = savedMapping(account.csv_mapping, read.table)
    if (saved) return setStep({ step: 'review', file, mapping: saved })
    const note = account.csv_mapping ? `The columns saved for ${account.name} are not all in this file, so check each one.` : null
    setStep({ step: 'columns', file, draft: guessCsvMapping(read.table, locale), note })
  }
  const restart = () => setStep({ step: 'start', problem: null })

  if (step.step === 'columns' && account) {
    return <Columns key={step.file.key} account={account} file={step.file} initial={step.draft} note={step.note} onBack={restart} onDone={(mapping) => setStep({ step: 'review', file: step.file, mapping })} />
  }
  if (step.step === 'review' && account) {
    return (
      <Review
        key={step.file.key}
        snapshot={snapshot}
        account={account}
        file={step.file}
        mapping={step.mapping}
        onColumns={() => setStep({ step: 'columns', file: step.file, draft: csvMappingDraft(step.mapping), note: null })}
        onRestart={restart}
      />
    )
  }
  return (
    <Screen title="Import" kind="page">
      <View style={{ gap: SPACE[6] }}>
        <Text tone="text2">Bank transactions from a CSV file go into one account. The file is read on this device, and only the rows you import are saved.</Text>
        {step.step === 'start' && step.problem ? <Banner tone="negative" title="File not read" body={step.problem} /> : null}
        <View style={{ gap: SPACE[2] }}>
          <Label>Into</Label>
          <Choices
            label="Into account"
            groups={[{ choices: accounts.map((a) => ({ value: a.id, title: a.name, detail: [KIND_WORDS[a.kind], a.currency, a.csv_mapping ? 'columns saved' : null].filter(Boolean).join(' · ') })) }]}
            value={account?.id ?? null}
            onChange={(id) => router.setParams({ account: id })}
          />
        </View>
        <View style={{ gap: SPACE[2], alignItems: 'flex-start' }}>
          <Button label="Choose a CSV file" variant="primary" disabled={!account} onPress={() => void choose()} />
          <Note>{account ? 'Download the transactions from your bank as a CSV file first.' : 'Pick the account the file belongs to first.'}</Note>
        </View>
      </View>
    </Screen>
  )
}

type Picking = Exclude<MappingField, 'date_order'> | 'reference'

const PICKER_TITLES: Record<Picking, string> = { date: 'Date', amount: 'Amount', debit: 'Money out', credit: 'Money in', description: 'Description', reference: 'Reference' }
const NONE = ''

function pickedColumn(draft: CsvMappingDraft, field: Picking): string {
  return draft[field] ?? NONE
}

function columnPatch(field: Picking, value: string): Partial<CsvMappingDraft> {
  const column = value === NONE ? null : value
  if (field === 'date') return { date: column }
  if (field === 'amount') return { amount: column }
  if (field === 'debit') return { debit: column }
  if (field === 'credit') return { credit: column }
  if (field === 'description') return { description: column }
  return { reference: column }
}

interface ColumnsProps {
  account: Account
  file: LoadedFile
  initial: CsvMappingDraft
  note: string | null
  onBack: () => void
  onDone: (mapping: CsvMapping) => void
}

// The first time per account: which column holds what, checked against the file's first rows, then remembered for the account on every device.
function Columns({ account, file, initial, note, onBack, onDone }: ColumnsProps) {
  const locale = useLocale()
  const { masked } = useMask()
  const { writable } = useSnapshot()
  const edit = useEdit()
  const [draft, setDraft] = useState(initial)
  const [tried, setTried] = useState(false)
  const [picking, setPicking] = useState<Picking | null>(null)
  const [open, setOpen] = useState(false)
  const read = readMapping(draft)
  const errors = tried && !read.ok ? read.errors : {}
  const columns = useMemo(() => columnChoices(file.table, masked), [file.table, masked])
  const preview = read.ok ? previewOf(file.table, read.mapping, account) : null
  const set = (patch: Partial<CsvMappingDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const go = () => {
    setTried(true)
    if (!read.ok) return
    const mapping = read.mapping
    if (!writable || !mappingChanged(account.csv_mapping, mapping)) return onDone(mapping)
    edit.mutate({ kind: 'csv_mapping', account_id: account.id, mapping }, { onSuccess: () => onDone(mapping) })
  }
  const field = (name: Picking) => {
    const value = draft[name]
    return (
      <SelectField
        label={PICKER_TITLES[name]}
        value={value}
        placeholder={name === 'reference' ? 'None' : 'Pick a column'}
        detail={value === null ? null : columns.find((c) => c.value === value)?.detail}
        error={name === 'reference' ? null : (errors[name] ?? null)}
        onPress={() => {
          setPicking(name)
          setOpen(true)
        }}
      />
    )
  }
  const failure = edit.error ? asDataError(edit.error) : null
  return (
    <>
      <Screen title="Import" kind="page">
        <View style={{ gap: SPACE[6] }}>
          <View style={{ gap: SPACE[1] }}>
            <Text variant="title2" level={2}>
              Match the columns
            </Text>
            <Note>{`${file.name} · ${rows(file.table.rows.length)}. ${writable ? `Saved for ${account.name}, so its next file maps itself on any device.` : 'Saving is off, so these are used for this file only.'}`}</Note>
          </View>
          {note ? <Banner tone="neutral" title="Columns changed" body={note} /> : null}
          {failure ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
          <View style={{ gap: SPACE[5] }}>
            {field('date')}
            <View style={{ gap: SPACE[2] }}>
              <Label>Dates are written</Label>
              <Choices label="Dates are written" groups={[{ choices: dateOrderChoices(firstValue(file.table, draft.date), (day) => longDay(day, locale)) }]} value={draft.date_order} onChange={(date_order) => set({ date_order })} />
              {errors.date_order ? <FieldError text={errors.date_order} /> : null}
            </View>
            <View style={{ gap: SPACE[2] }}>
              <Label>Amounts</Label>
              <Segmented
                label="Amounts"
                options={[
                  { value: 'one', label: 'One column' },
                  { value: 'two', label: 'Out and in' },
                ]}
                value={draft.two_columns ? 'two' : 'one'}
                onChange={(v) => set({ two_columns: v === 'two' })}
              />
              <Note>{draft.two_columns ? 'Money out and money in are in two columns.' : 'One column, with a minus sign on money out.'}</Note>
            </View>
            {draft.two_columns ? (
              <>
                {field('debit')}
                {field('credit')}
              </>
            ) : (
              field('amount')
            )}
            <View style={{ gap: SPACE[2] }}>
              <Label>Decimal mark</Label>
              <Segmented
                label="Decimal mark"
                options={[
                  { value: '.', label: '1,234.56' },
                  { value: ',', label: '1.234,56' },
                ]}
                value={draft.decimal}
                onChange={(decimal) => set({ decimal })}
              />
            </View>
            {field('description')}
            <View style={{ gap: SPACE[2] }}>
              {field('reference')}
              <Note>Optional: a column with a different value on every row, such as the bank’s transaction ID. With none, rows are told apart by date, amount and description.</Note>
            </View>
          </View>
          {preview ? <Preview account={account} drafts={preview.drafts} skipped={preview.skipped} /> : null}
          <View style={BUTTON_ROW}>
            <Button label={edit.isPending ? 'Saving…' : 'Continue'} variant="primary" disabled={edit.isPending} onPress={go} />
            <Plain label="Choose another file" onPress={onBack} />
          </View>
        </View>
      </Screen>
      <Sheet open={open} onClose={() => setOpen(false)} title={picking ? `${PICKER_TITLES[picking]} column` : 'Column'}>
        {picking ? (
          <Choices
            label={`${PICKER_TITLES[picking]} column`}
            groups={[{ choices: picking === 'reference' ? [{ value: NONE, title: 'None', detail: 'Tell rows apart by date, amount and description' }, ...columns] : columns }]}
            value={pickedColumn(draft, picking)}
            onChange={(value) => set(columnPatch(picking, value))}
            onPress={() => setOpen(false)}
          />
        ) : null}
      </Sheet>
    </>
  )
}

function Preview({ account, drafts, skipped }: { account: Account; drafts: readonly CsvDraft[]; skipped: readonly CsvSkip[] }) {
  const locale = useLocale()
  const { masked } = useMask()
  const day = (iso: string) => shortDay(iso, locale, true)
  const lines = [...drafts.map((d) => ({ row: d.row, draft: d, skip: null })), ...skipped.map((s) => ({ row: s.row, draft: null, skip: s }))].sort((a, b) => a.row - b.row)
  return (
    <View style={{ gap: SPACE[2] }}>
      <Label>The first rows, as read</Label>
      <Card flush>
        {lines.map((line, i) => (
          <View key={line.row} style={{ paddingHorizontal: GUTTER, paddingVertical: SPACE[3], flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3] }}>
            {i > 0 ? <Divider /> : null}
            <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
              <Text>{line.draft ? describe(line.draft.description, masked) : `Row ${line.row}`}</Text>
              <Text variant="footnote" tone="text2">
                {line.draft ? `${day(line.draft.posted_on)} · ${line.draft.amount_minor < 0 ? 'Money out' : 'Money in'}` : line.skip ? skipWords(line.skip, account, masked, day) : ''}
              </Text>
            </View>
            {line.draft ? (
              <View style={{ flexShrink: 0, maxWidth: '45%', alignItems: 'flex-end' }}>
                <Money minor={line.draft.amount_minor} currency={account.currency} signed />
              </View>
            ) : null}
          </View>
        ))}
      </Card>
    </View>
  )
}

function Divider() {
  const { colors } = useTheme()
  return <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} />
}

interface ReviewProps {
  snapshot: Snapshot
  account: Account
  file: LoadedFile
  mapping: CsvMapping
  onColumns: () => void
  onRestart: () => void
}

interface Done {
  batch_id: string
  summary: ReviewSummary
}

type Notice = { kind: 'meanwhile'; count: number } | { kind: 'undone'; count: number }

const EMPTY: ReadonlySet<string> = new Set()

// Every row of the file: rows the account already has are greyed and left out; the rest are ticked, with suggested categories and links, and go in as one batch.
function Review({ snapshot, account, file, mapping, onColumns, onRestart }: ReviewProps) {
  const router = useRouter()
  const { writable, source, offline } = useSnapshot()
  const { owner } = useDataSource()
  const save = usePostBatch()
  const undo = useEdit()
  const read = useMemo(() => csvDrafts(file.table, mapping, account), [file.table, mapping, account])
  const drafts = useMemo(() => (read.ok ? read.value.drafts : []), [read])
  const skipped = useMemo(() => (read.ok ? read.value.skipped : []), [read])
  const days = useMemo(() => fileDays(drafts), [drafts])
  const live = source.kind === 'supabase'
  // The one request for the account's external ids around the file's dates.
  const recordedQuery = useQuery({
    queryKey: ['csv-recorded', owner, account.id, days?.from ?? '', days?.to ?? ''],
    queryFn: () => recordedIds(getSupabase(), account.id, days?.from ?? '', days?.to ?? ''),
    enabled: live && days !== null,
    staleTime: 0,
    gcTime: 0,
  })
  // Rows post_batch refused because another device saved them while this one reviewed.
  const [refused, setRefused] = useState<ReadonlySet<string>>(EMPTY)
  const recorded = useMemo(() => {
    const ids = new Map<string, RecordedRow | null>([...refused].map((id) => [id, null]))
    for (const [id, row] of recordedQuery.data ?? []) ids.set(id, row)
    for (const t of snapshotIndex(snapshot).rowsByAccount.get(account.id) ?? []) if (t.external_id !== null) ids.set(t.external_id, { posted_on: t.posted_on, amount_minor: t.amount_minor })
    return ids
  }, [recordedQuery.data, refused, snapshot, account.id])
  // Ids made once per file, so a retry after a lost reply saves each row once (post_batch already_applied).
  const ids = useRef(new Map<string, string>())
  const idOf = useCallback((key: string) => {
    let id = ids.current.get(key)
    if (!id) ids.current.set(key, (id = randomId()))
    return id
  }, [])
  const [batchId] = useState(randomId)
  const list = useMemo(() => reviewRows(snapshot, account.id, drafts, recorded, idOf), [snapshot, account.id, drafts, recorded, idOf])
  const [choices, setChoices] = useState<ReadonlyMap<string, RowChoice>>(new Map())
  const [done, setDone] = useState<Done | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const names = useMemo(() => new Map(snapshot.doc.categories.map((c) => [c.id, c])), [snapshot])
  const summary = reviewSummary(list, choices)
  const checking = live && days !== null && recordedQuery.isPending

  const change = useCallback((row: ReviewRow, patch: Partial<RowChoice>) => setChoices((all) => new Map(all).set(row.key, { ...choiceOf(row, all), ...patch })), [])
  const toggle = useCallback((row: ReviewRow) => setChoices((all) => new Map(all).set(row.key, { ...choiceOf(row, all), include: !choiceOf(row, all).include })), [])
  const openRow = useCallback((key: string) => {
    setEditing(key)
    setOpen(true)
  }, [])

  const post = () => {
    const batch = importBatch(account.id, list, choices, batchId, snapshot.doc.categories)
    if (!batch) return
    setNotice(null)
    save.mutate(batch, {
      onSuccess: () => {
        setDone({ batch_id: batch.batch_id, summary })
        void recordedQuery.refetch()
      },
      onError: (error) => {
        const e = asDataError(error)
        const external = (e.detail as { external_ids?: unknown } | null)?.external_ids
        if (e.code !== 'already_recorded' || !Array.isArray(external)) return
        setRefused((before) => new Set([...before, ...external.filter((x): x is string => typeof x === 'string')]))
        setNotice({ kind: 'meanwhile', count: external.length })
        save.reset()
        void recordedQuery.refetch()
      },
    })
  }
  const back = (count: number, batch: string) =>
    undo.mutate(
      { kind: 'delete_batch', batch_id: batch },
      {
        onSuccess: () => {
          setNotice({ kind: 'undone', count })
          setDone(null)
          save.reset()
          undo.reset()
          void recordedQuery.refetch()
        },
      },
    )

  if (done) {
    const count = done.summary.ticked
    const failure = undo.error ? asDataError(undo.error) : null
    // Another device undid it first, or deleted the rows.
    const gone = failure?.code === 'stale'
    return (
      <Screen title="Import" kind="page">
        <View style={{ gap: SPACE[6] }}>
          <Banner tone="positive" title={`Imported ${rows(count)}`} body={`Into ${account.name}, as one batch. Undo deletes exactly ${count === 1 ? 'this row' : `these ${count} rows`}.`} />
          {gone ? (
            <Banner tone="neutral" title="Already undone" body={`These rows are no longer in ${account.name}.`} />
          ) : failure ? (
            <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} />
          ) : null}
          <Totals account={account} summary={done.summary} done />
          <View style={BUTTON_ROW}>
            <View style={{ flexShrink: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE[2] }}>
              <Button label={`Open ${account.name}`} variant="primary" onPress={() => router.push({ pathname: '/money/[accountId]', params: { accountId: account.id } })} />
              {gone ? null : <Button label={undo.isPending ? 'Undoing…' : 'Undo'} disabled={undo.isPending || !writable} onPress={() => back(count, done.batch_id)} />}
            </View>
            <Plain label="Import another file" onPress={onRestart} />
          </View>
        </View>
      </Screen>
    )
  }

  const failure = save.error ? asDataError(save.error) : null
  const off = writable ? null : source.kind === 'sample' ? 'Samples are read-only. Sign in to import into your own accounts.' : offline ? 'Waypoint is offline. Importing comes back once it reaches the server.' : 'Your household is still loading.'
  const label = save.isPending ? 'Importing…' : summary.ticked === 0 ? 'Nothing to import' : `Import ${rows(summary.ticked)}`
  const disabled = save.isPending || !writable || checking || recordedQuery.isError || summary.ticked === 0
  const actions = <Actions label={label} disabled={disabled} onImport={post} onColumns={onColumns} />
  const items: ListItem[] = [...reviewItems(list, skipped), { type: 'end', key: 'end' }]
  const editingRow = list.find((r) => r.key === editing) ?? null
  return (
    <>
      <Screen
        title="Import"
        kind="page"
        list={{
          data: items,
          keyOf: (item) => item.key,
          render: (item) => <ReviewCell item={item} choices={choices} account={account} names={names} onToggle={toggle} onOpen={openRow} end={actions} />,
        }}
      >
        <View style={{ gap: SPACE[4], paddingBottom: SPACE[4] }}>
          <View style={{ gap: SPACE[1] }}>
            <Text variant="title2" level={2}>
              Review the rows
            </Text>
            <Note>{`${file.name} into ${account.name}. Tap a row for its kind, category and link.`}</Note>
          </View>
          {!read.ok ? <Banner tone="negative" title="Columns missing" body={read.errors.join(' ')} action={{ label: 'Change columns', onPress: onColumns }} /> : null}
          {notice?.kind === 'meanwhile' ? (
            <Banner
              tone="caution"
              title="Imported elsewhere meanwhile"
              body={`${notice.count === 1 ? 'One row was' : `${notice.count} rows were`} saved on another device while you reviewed. ${notice.count === 1 ? 'It is' : 'They are'} greyed out now; Import adds the rest.`}
            />
          ) : null}
          {list.length > 0 && summary.recorded === list.length ? <Banner tone="neutral" title="Nothing new" body={`Every row of this file is in ${account.name} already, so there is nothing to add.`} /> : null}
          {notice?.kind === 'undone' ? <Banner tone="neutral" title="Undone" body={`The ${rows(notice.count)} imported are no longer in ${account.name}.`} /> : null}
          {failure && failure.kind !== 'read_only' ? <Banner tone="negative" title={ERROR_TITLES[failure.kind]} body={failure.message} detail={failure.technical ?? undefined} /> : null}
          {recordedQuery.isError ? (
            <Banner tone="negative" title="Not checked for rows already imported" body={asDataError(recordedQuery.error).message} action={{ label: 'Retry', icon: 'rotate-cw', onPress: () => void recordedQuery.refetch() }} />
          ) : null}
          {off ? <Banner tone="neutral" title="Saving is off" body={off} /> : null}
          <Totals account={account} summary={summary} done={false} />
          <Actions label={label} disabled={disabled} onImport={post} onColumns={onColumns} onRestart={onRestart} />
        </View>
      </Screen>
      <RowSheet snapshot={snapshot} account={account} row={editingRow} choice={editingRow ? choiceOf(editingRow, choices) : null} open={open} onClose={() => setOpen(false)} onChange={change} />
    </>
  )
}

// A plain button's padding is pulled back on its left, and the row's gap widened by as much, so one that wraps to a new line starts its word at the column's edge.
const BUTTON_ROW = { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE[2] + SPACE[5], rowGap: SPACE[2] } as const

function Plain({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <View style={{ marginLeft: -GUTTER }}>
      <Button label={label} variant="plain" onPress={onPress} />
    </View>
  )
}

function Actions({ label, disabled, onImport, onColumns, onRestart }: { label: string; disabled: boolean; onImport: () => void; onColumns: () => void; onRestart?: () => void }) {
  return (
    <View style={BUTTON_ROW}>
      <Button label={label} variant="primary" disabled={disabled} onPress={onImport} />
      <Plain label="Change columns" onPress={onColumns} />
      {onRestart ? <Plain label="Choose another file" onPress={onRestart} /> : null}
    </View>
  )
}

function Totals({ account, summary, done }: { account: Account; summary: ReviewSummary; done: boolean }) {
  const facts: [string, ReactNode][] = [
    [
      done ? 'Imported' : 'To import',
      <Text key="n" variant="headline" numbers>
        {String(summary.ticked)}
      </Text>,
    ],
    [
      'Already imported',
      <Text key="r" variant="headline" numbers>
        {String(summary.recorded)}
      </Text>,
    ],
    ...(summary.entered > 0
      ? ([
          [
            'Entered by hand',
            <Text key="e" variant="headline" numbers>
              {String(summary.entered)}
            </Text>,
          ],
        ] as [string, ReactNode][])
      : []),
    ['Money in', <Money key="in" minor={summary.in_minor} currency={account.currency} variant="headline" />],
    ['Money out', <Money key="out" minor={summary.out_minor} currency={account.currency} variant="headline" />],
  ]
  return (
    // Two columns down to 320 px wide.
    <Card style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[4], rowGap: SPACE[3] }}>
      {facts.map(([title, figure]) => (
        <View key={title} style={{ flexGrow: 1, flexBasis: 100, gap: SPACE[1] }}>
          <Text variant="footnote" tone="text2">
            {title}
          </Text>
          {figure}
        </View>
      ))}
    </Card>
  )
}

type ListItem = ReviewItem | { type: 'end'; key: string }

interface CellProps {
  item: ListItem
  choices: ReadonlyMap<string, RowChoice>
  account: Account
  names: ReadonlyMap<string, Category>
  onToggle: (row: ReviewRow) => void
  onOpen: (key: string) => void
  end: ReactNode
}

const sameChoice = (a: RowChoice, b: RowChoice) => a.include === b.include && a.refund === b.refund && a.category === b.category && a.link === b.link

// One list item. Memoised, as the list redraws every cell whenever the screen redraws; a row redraws only when its own choice changes.
const ReviewCell = memo(
  function ReviewCell({ item, choices, account, names, onToggle, onOpen, end }: CellProps) {
    if (item.type === 'end') return <View style={{ paddingTop: SPACE[6], paddingBottom: SPACE[4] }}>{end}</View>
    if (item.type === 'heading') {
      return (
        <View style={{ paddingTop: SPACE[6], paddingBottom: SPACE[2], paddingHorizontal: SPACE[1] }}>
          <Text variant="subhead" tone="text2" level={3} style={{ fontWeight: '600' }}>
            {item.title}
          </Text>
        </View>
      )
    }
    if (item.type === 'skip') return <SkipLine skip={item.skip} account={account} first={item.first} last={item.last} />
    return <ImportRow row={item.row} choice={choiceOf(item.row, choices)} account={account} names={names} first={item.first} last={item.last} onToggle={onToggle} onOpen={onOpen} />
  },
  (a, b) =>
    a.item === b.item &&
    a.account === b.account &&
    a.names === b.names &&
    a.onToggle === b.onToggle &&
    a.onOpen === b.onOpen &&
    (b.item.type === 'end' ? a.end === b.end : b.item.type !== 'row' || sameChoice(choiceOf(b.item.row, a.choices), choiceOf(b.item.row, b.choices))),
)

// A group of rows reads as one card: the first and last round its corners.
function edges(first: boolean, last: boolean, colors: { surface: string; line: string }): ViewStyle {
  const top = first ? RADII.card : 0
  const bottom = last ? RADII.card : 0
  return {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderLeftWidth: LINE_WIDTH,
    borderRightWidth: LINE_WIDTH,
    borderTopWidth: first ? LINE_WIDTH : 0,
    borderBottomWidth: last ? LINE_WIDTH : 0,
    borderTopLeftRadius: top,
    borderTopRightRadius: top,
    borderBottomLeftRadius: bottom,
    borderBottomRightRadius: bottom,
  }
}

function rowDetail(row: ReviewRow, choice: RowChoice, names: ReadonlyMap<string, Category>, locale: string): string {
  if (row.recorded) return `${shortDay(row.draft.posted_on, locale)} · Already imported`
  if (row.entered && !choice.include) return `${shortDay(row.draft.posted_on, locale)} · Looks like an entry you made on ${shortDay(row.entered.posted_on, locale)}. Tick it to import anyway.`
  const kind = kindOf(row, choice)
  const parts = [shortDay(row.draft.posted_on, locale), kind === 'expense' ? 'Expense' : kind === 'refund' ? 'Refund' : 'Income']
  const category = takesCategory(kind) && choice.category !== null ? names.get(choice.category) : undefined
  if (category) parts.push(category.name)
  if (choice.link && row.link) parts.push(`Settles ${row.link.name}`)
  if (!choice.include) parts.push('Left out')
  return parts.join(' · ')
}

interface ImportRowProps {
  row: ReviewRow
  choice: RowChoice
  account: Account
  names: ReadonlyMap<string, Category>
  first: boolean
  last: boolean
  onToggle: (row: ReviewRow) => void
  onOpen: (key: string) => void
}

function ImportRow({ row, choice, account, names, first, last, onToggle, onOpen }: ImportRowProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const { masked } = useMask()
  const locale = useLocale()
  const title = describe(row.draft.description, masked)
  const detail = rowDetail(row, choice, names, locale)
  // The whole row takes the hover and press tint, the checkbox column too.
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)
  // A row the account already has is greyed: lighter words, and its box off and fixed.
  const tone = row.recorded ? 'text3' : 'text'
  return (
    <View style={[edges(first, last, colors), { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: SPACE[1], overflow: 'hidden' }, hovered || pressed ? { backgroundColor: colors.surface2 } : null]}>
      {first ? null : <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} />}
      <View style={{ paddingTop: SPACE[1] }}>
        <Checkbox variant="box" label={`Import ${title}`} checked={choice.include} disabled={row.recorded} onChange={() => onToggle(row)} />
      </View>
      <Pressable
        role="button"
        aria-label={`${title}. ${detail}`}
        onPress={() => onOpen(row.key)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        onFocus={onFocus}
        onBlur={onBlur}
        style={[{ flex: 1, minWidth: 0, minHeight: ROW_MIN_HEIGHT, flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[3], paddingLeft: SPACE[1], paddingRight: GUTTER, paddingVertical: SPACE[3] }, ring && { ...ring, outlineOffset: -2 }]}
      >
        <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
          <Text tone={tone}>{title}</Text>
          <Text variant="footnote" tone={row.recorded ? 'text3' : 'text2'}>
            {detail}
          </Text>
        </View>
        <View style={{ flexShrink: 0, maxWidth: '45%', alignItems: 'flex-end' }}>
          <Money minor={row.draft.amount_minor} currency={account.currency} signed tone={tone} />
        </View>
      </Pressable>
    </View>
  )
}

function SkipLine({ skip, account, first, last }: { skip: CsvSkip; account: Account; first: boolean; last: boolean }) {
  const { colors } = useTheme()
  const { masked } = useMask()
  const locale = useLocale()
  return (
    <View style={[edges(first, last, colors), { paddingHorizontal: GUTTER, paddingVertical: SPACE[3], gap: SPACE[1] }]}>
      {first ? null : <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} />}
      <Text tone="text2">{`Row ${skip.row}`}</Text>
      <Text variant="footnote" tone="text2">
        {skipWords(skip, account, masked, (iso) => shortDay(iso, locale, true))}
      </Text>
    </View>
  )
}

interface RowSheetProps {
  snapshot: Snapshot
  account: Account
  row: ReviewRow | null
  choice: RowChoice | null
  open: boolean
  onClose: () => void
  onChange: (row: ReviewRow, patch: Partial<RowChoice>) => void
}

const NO_CATEGORY = ''

// One row: whether it goes in, money in as income or a refund, the plan item it settles, and its category.
function RowSheet({ snapshot, account, row, choice, open, onClose, onChange }: RowSheetProps) {
  // Kept while the sheet animates out.
  const kept = useRef<{ row: ReviewRow; choice: RowChoice } | null>(null)
  if (row && choice) kept.current = { row, choice }
  const shown = kept.current
  const categories = useMemo(() => snapshot.doc.categories.filter((c) => c.archived_at === null).sort((a, b) => a.name.localeCompare(b.name)), [snapshot])
  return (
    <Sheet open={open} onClose={onClose} title={shown ? `Row ${shown.row.draft.row}` : 'Row'}>
      {shown ? <RowBody key={shown.row.key} account={account} row={shown.row} choice={shown.choice} categories={categories} onChange={(patch) => onChange(shown.row, patch)} onClose={onClose} /> : null}
    </Sheet>
  )
}

interface RowBodyProps {
  account: Account
  row: ReviewRow
  choice: RowChoice
  categories: readonly Category[]
  onChange: (patch: Partial<RowChoice>) => void
  onClose: () => void
}

function RowBody({ account, row, choice, categories, onChange, onClose }: RowBodyProps) {
  const locale = useLocale()
  const { masked } = useMask()
  const kind = kindOf(row, choice)
  return (
    <View style={{ gap: SPACE[4] }}>
      <View style={{ gap: SPACE[1] }}>
        <Text variant="headline">{describe(row.draft.description, masked)}</Text>
        <Text variant="subhead" tone="text2">
          {`${longDay(row.draft.posted_on, locale)} · ${account.name}`}
        </Text>
        <Money minor={row.draft.amount_minor} currency={account.currency} signed variant="title2" />
      </View>
      {row.recorded ? (
        <Banner tone="neutral" title="Already imported" body={`${account.name} already has this row, so it is left out.`} />
      ) : (
        <>
          <Checkbox label="Import this row" checked={choice.include} onChange={(include) => onChange({ include })} />
          {row.draft.amount_minor > 0 ? (
            <View style={{ gap: SPACE[2] }}>
              <Label>Kind</Label>
              <Segmented
                label="Kind"
                options={[
                  { value: 'income', label: 'Income' },
                  { value: 'refund', label: 'Refund' },
                ]}
                value={kind === 'refund' ? 'refund' : 'income'}
                onChange={(v) => onChange({ refund: v === 'refund' })}
              />
              <Note>{kind === 'refund' ? 'Money back for something bought; it can carry a category.' : 'Money earned or received.'}</Note>
            </View>
          ) : null}
          {row.link ? <Checkbox label={`Settles: ${row.link.name} · ${periodLabel(row.link.period, locale)}`} detail="Links this row to that plan item, as Record does." checked={choice.link} onChange={(link) => onChange({ link })} /> : null}
          {takesCategory(kind) && categories.length > 0 ? (
            <View style={{ gap: SPACE[2] }}>
              <Label>Category</Label>
              <Choices
                label="Category"
                groups={[{ choices: [{ value: NO_CATEGORY, title: 'No category' }, ...categories.map((c) => ({ value: c.id, title: c.name, detail: c.id === row.category ? 'Last used for this description' : undefined }))] }]}
                value={choice.category ?? NO_CATEGORY}
                onChange={(id) => onChange({ category: id === NO_CATEGORY ? null : id })}
              />
            </View>
          ) : null}
        </>
      )}
      <View style={{ alignItems: 'flex-end' }}>
        <Button label="Done" variant="primary" onPress={onClose} />
      </View>
    </View>
  )
}
