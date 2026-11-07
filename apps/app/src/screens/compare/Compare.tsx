import { MASK, type Lever, type Snapshot } from '@waypoint/core'
import { registry } from '@waypoint/core/compare'
import * as Clipboard from 'expo-clipboard'
import * as Linking from 'expo-linking'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { memo, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Platform, Pressable, ScrollView, View, useWindowDimensions, type PressableStateCallbackType, type TextStyle, type ViewStyle } from 'react-native'
import { useSnapshot } from '@/data/hooks'
import { useDataSource } from '@/data/source'
import { leverFragment, monthTitle } from '@/shell/url.model'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Choices } from '@/ui/Choices'
import { CopyText } from '@/ui/CopyText'
import { EmptyState } from '@/ui/EmptyState'
import { Money } from '@/ui/Money'
import { Sheet } from '@/ui/Sheet'
import { Pill } from '@/ui/Pill'
import { Text, type TextTone } from '@/ui/Text'
import { useFocusRing, useLocale, useMask, useTheme } from '@/ui/theme'
import { GUTTER, LINE_WIDTH, ROW_MIN_HEIGHT, SPACE, type TextRole } from '@/ui/tokens'
import {
  cardCells,
  columnWidths,
  compareLink,
  compareView,
  DEFAULT_SORT,
  draftOf,
  fragmentOf,
  leversOf,
  MAX_LEVERS,
  sameLever,
  TABLE_CELL_PAD,
  TABLE_LABEL_MIN,
  TABLE_MIN_WIDTH,
  type Cell,
  type Change,
  type Column,
  type CompareView,
  type LeverDraft,
  type OptionRow,
  type Value,
  type Verdict,
} from './compare.model'
import { Picker } from './Picker'
import { useCompare } from './useCompare'

const NO_LEVERS: readonly Lever[] = []

// Spec §7 Compare: the plan beside each change and all of them together, as phone cards of the figures that moved or a table from 1,024 px. The changes live after #l= in the address, which browsers never send to a server.
export function CompareBody() {
  const { snapshot } = useSnapshot()
  return snapshot ? <Body snapshot={snapshot} /> : null
}

function Body({ snapshot }: { snapshot: Snapshot }) {
  const router = useRouter()
  const locale = useLocale()
  const wide = useWindowDimensions().width >= TABLE_MIN_WIDTH
  const { '#': hash } = useLocalSearchParams<{ '#'?: string }>()
  // A new list of changes draws as a transition, split between frames, so following a link never holds the thread (spec §11: 50 ms at 4x slowdown).
  const fragment = useDeferredValue(leverFragment(hash), null)
  const reading = fragment === null && leverFragment(hash) !== null
  const link = useMemo(() => leversOf(fragment), [fragment])
  const levers = link.ok ? link.levers : NO_LEVERS
  const run = useCompare(snapshot, levers, fragment ?? '')
  const [sortId, setSortId] = useState(DEFAULT_SORT)
  const view = useMemo(() => compareView(snapshot, levers, run.results, sortId, locale), [snapshot, levers, run.results, sortId, locale])
  const [picking, setPicking] = useState(false)
  const [sorting, setSorting] = useState(false)
  // The change opened on its own form, by its place on the list.
  const [editing, setEditing] = useState<{ index: number; draft: LeverDraft } | null>(null)
  const drafts = useMemo(() => {
    const reg = registry(snapshot)
    return levers.map((l) => draftOf(snapshot, reg, l, locale))
  }, [snapshot, levers, locale])
  const pick = () => {
    setEditing(null)
    setPicking(true)
  }
  const edit = (index: number) => {
    const draft = drafts[index]
    if (!draft) return
    setEditing({ index, draft })
    setPicking(true)
  }

  // The changes replace the address's fragment, so Back leaves Compare and a copied address opens the same list; '' clears it, where undefined would write '#undefined'.
  const setLevers = (next: readonly Lever[]) => router.setParams({ '#': fragmentOf(next) ?? '' } as Record<string, string>)
  const add = (lever: Lever): string | null => {
    if (levers.some((l) => sameLever(l, lever))) return 'This change is already on the list.'
    if (levers.length >= MAX_LEVERS) return `A comparison holds at most ${MAX_LEVERS} changes. Remove one first.`
    setLevers([...levers, lever])
    return null
  }
  const remove = (index: number) => setLevers(levers.filter((_, i) => i !== index))
  const replace = (index: number, lever: Lever): string | null => {
    if (levers.some((l, i) => i !== index && sameLever(l, lever))) return 'This change is already on the list.'
    setLevers(levers.map((l, i) => (i === index ? lever : l)))
    return null
  }
  const editable = (index: number | null) => index !== null && drafts[index] !== null && drafts[index] !== undefined
  const baseline = run.results[0]

  return (
    <View style={{ gap: SPACE[5] }}>
      {!link.ok ? (
        <Banner tone="negative" title="This link’s changes could not be read" body="It may have been cut short when it was copied." detail={link.errors.join('; ')} action={{ label: 'Start again', onPress: () => setLevers([]) }} />
      ) : null}
      {reading ? (
        <Text tone="text2">Reading the changes…</Text>
      ) : levers.length === 0 ? (
        <Card>
          <EmptyState title="Nothing to compare yet" body="Pick a change, such as a rent rise or a loan offer, and see it beside your plan as it stands." action={{ label: 'Pick a change to try', onPress: pick }} />
        </Card>
      ) : (
        <>
          <Intro snapshot={snapshot} view={view} />
          <Actions levers={levers} full={levers.length >= MAX_LEVERS} onAdd={pick} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: SPACE[3], rowGap: SPACE[1], marginBottom: -SPACE[2] }}>
            <Text variant="title2" level={2}>
              Results
            </Text>
            <View style={{ marginRight: -SPACE[3] }}>
              <Button label={`Sort: ${view.sort.title}`} icon="arrow-up-down" variant="plain" size="small" onPress={() => setSorting(true)} accessibilityLabel={`Sort: ${view.sort.title}. Change the order`} />
            </View>
          </View>
          {baseline && !baseline.ok ? (
            <Banner tone="negative" title="Could not work out the plan" body="Nothing can be compared until the plan as it stands works out." detail={baseline.errors.join(' ')} />
          ) : wide ? (
            <Table view={view} onRemove={remove} onEdit={edit} editable={editable} />
          ) : (
            <View style={{ gap: SPACE[3] }}>
              {view.rows.map((row) => (
                <OptionCard key={row.key} row={row} columns={view.columns} onRemove={remove} onEdit={editable(row.lever) ? edit : null} />
              ))}
            </View>
          )}
        </>
      )}
      <Picker open={picking} onClose={() => setPicking(false)} snapshot={snapshot} onAdd={editing ? (lever) => replace(editing.index, lever) : add} editing={editing?.draft ?? null} />
      <Sheet open={sorting} onClose={() => setSorting(false)} title="Sort by">
        <Text variant="footnote" tone="text2">
          Options are listed best first by this figure, after the plan as it stands.
        </Text>
        <Choices<string>
          label="Sort by"
          groups={[{ choices: view.columns.map((c) => ({ value: c.id, title: c.title })) }]}
          value={view.sort.id}
          onChange={setSortId}
          onPress={() => setSorting(false)}
        />
      </Sheet>
    </View>
  )
}

function Intro({ snapshot, view }: { snapshot: Snapshot; view: CompareView }) {
  const locale = useLocale()
  return (
    <Text variant="footnote" tone="text2">
      {`Each change is measured on its own against your plan, then all together, from today to the end of ${monthTitle(view.horizon_month, locale)}. Net worth is cash minus what is owed then. Net worth and interest are in ${snapshot.doc.household.base_currency} at today’s rates.`}
    </Text>
  )
}

function Actions({ levers, full, onAdd }: { levers: readonly Lever[]; full: boolean; onAdd: () => void }) {
  const { source } = useDataSource()
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const [shown, setShown] = useState<string | null>(null)
  useEffect(() => {
    if (copied !== 'yes') return
    const timer = setTimeout(() => setCopied(null), 4000)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => {
    const page = Platform.OS === 'web' ? `${globalThis.location.origin}/plan/compare` : process.env.EXPO_PUBLIC_WEB_URL ? `${process.env.EXPO_PUBLIC_WEB_URL.replace(/\/+$/, '')}/plan/compare` : Linking.createURL('plan/compare')
    const url = compareLink(page, source.kind === 'sample' ? source.id : null, levers)
    Clipboard.setStringAsync(url).then(
      (done) => {
        setCopied(done ? 'yes' : 'no')
        setShown(done ? null : url)
      },
      () => {
        setCopied('no')
        setShown(url)
      },
    )
  }
  return (
    <View style={{ gap: SPACE[2] }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE[2] }}>
        <Button label="Add a change" icon="plus" variant="primary" disabled={full} onPress={onAdd} />
        <Button label={copied === 'yes' ? 'Link copied' : 'Copy link'} icon={copied === 'yes' ? 'check' : 'link'} onPress={copy} />
      </View>
      {copied === 'no' || full ? (
        <Text aria-live="polite" variant="footnote" tone="text2">
          {copied === 'no' ? 'This browser did not let Waypoint copy. Select the link below and copy it.' : `A comparison holds at most ${MAX_LEVERS} changes.`}
        </Text>
      ) : null}
      {shown ? (
        <Text selectable variant="footnote" style={{ fontFamily: Platform.OS === 'web' ? 'ui-monospace, monospace' : undefined }}>
          {shown}
        </Text>
      ) : null}
    </View>
  )
}

// A link's change in a shape Compare does not know keeps its words, digits and all; the eye hides every digit.
const maskDigits = (text: string) => text.replace(/\d[\d.,'\u00a0\u202f ]*\d|\d/g, MASK)

function Title({ row, variant }: { row: OptionRow; variant: TextRole }) {
  const { masked } = useMask()
  if (!row.opaque) return <CopyText copy={row.title} variant={variant} />
  const text = row.title.map((p) => ('text' in p ? p.text : '')).join('')
  return <Text variant={variant}>{masked ? maskDigits(text) : text}</Text>
}

const NOTES: Record<OptionRow['role'], string | null> = { baseline: 'Your plan as it stands', together: 'Every change at once', lever: null }

function useNumbers() {
  const locale = useLocale()
  return useMemo(() => {
    const signed = new Intl.NumberFormat(locale, { signDisplay: 'exceptZero' })
    const points = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' })
    const percent = new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
    return { signed, points, percent }
  }, [locale])
}

const plural = (n: number, word: string) => `${word}${Math.abs(n) === 1 ? '' : 's'}`

function ValueText({ value, variant, tone, prefix = '' }: { value: Value; variant: TextRole; tone: TextTone; prefix?: string }) {
  const { percent } = useNumbers()
  switch (value.kind) {
    case 'money':
      return (
        <Text variant={variant} tone={tone} numbers>
          {prefix}
          <Money minor={value.minor} currency={value.currency} variant={variant} tone={tone} />
        </Text>
      )
    case 'days':
      return <Text variant={variant} tone={tone} numbers>{`${prefix}${value.n} ${plural(value.n, 'day')}`}</Text>
    case 'percent':
      return <Text variant={variant} tone={tone} numbers>{`${prefix}${percent.format(value.fraction)}${value.or_more ? ' or more' : ''}`}</Text>
    case 'copy':
      return <CopyText copy={prefix ? [{ text: prefix }, ...value.copy] : value.copy} variant={variant} tone={tone} />
    case 'unknown':
      return <Text variant={variant} tone={tone}>{`${prefix}Not known`}</Text>
  }
}

function ChangeText({ change, variant, tone, style }: { change: Change; variant: TextRole; tone: TextTone; style?: TextStyle }) {
  const { signed, points } = useNumbers()
  switch (change.kind) {
    case 'money':
      return <Money minor={change.minor} currency={change.currency} signed variant={variant} tone={tone} style={style} />
    case 'days':
      return <Text variant={variant} tone={tone} numbers style={style}>{`${signed.format(change.n)} ${plural(change.n, 'day')}`}</Text>
    case 'points':
      return <Text variant={variant} tone={tone} numbers style={style}>{`${points.format(change.fraction * 100)} points`}</Text>
    case 'months':
      return <Text variant={variant} tone={tone} numbers style={style}>{change.n === 0 ? 'Same month' : `${Math.abs(change.n)} ${plural(change.n, 'month')} ${change.n > 0 ? 'later' : 'earlier'}`}</Text>
    case 'text':
      return <Text variant={variant} tone={tone} style={style}>{change.text}</Text>
  }
}

const STRONG: TextStyle = { fontWeight: '600' }

// Whether a change helps, in words with its icon, so a minus on interest reads as good and a plus on days under the floor as bad.
function VerdictPill({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return null
  return (
    <View style={{ alignSelf: 'flex-end' }}>
      <Pill tone={verdict === 'Better' ? 'positive' : 'negative'}>{verdict}</Pill>
    </View>
  )
}

function Rule() {
  const { colors } = useTheme()
  return <View style={{ height: LINE_WIDTH, backgroundColor: colors.line }} />
}

interface CardProps {
  row: OptionRow
  columns: readonly Column[]
  onRemove: (index: number) => void
  // Opens the change on its own form; null for the plan, all together, and a change the picker cannot rebuild.
  onEdit: ((index: number) => void) | null
}

// A change's name and note: a press target that opens the change to edit, with the kit's hover and focus states.
function EditTarget({ row, onEdit, children }: { row: OptionRow; onEdit: ((index: number) => void) | null; children: ReactNode }) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const index = row.lever
  if (!onEdit || index === null) return <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>{children}</View>
  const hover = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { backgroundColor: colors.surface2 } : null)
  return (
    <Pressable
      role="button"
      aria-label={`Edit ${row.name}`}
      onPress={() => onEdit(index)}
      onFocus={onFocus}
      onBlur={onBlur}
      style={(s) => [{ flex: 1, minWidth: 0, gap: SPACE[1], marginVertical: -SPACE[1], paddingVertical: SPACE[1], marginLeft: -SPACE[2], paddingLeft: SPACE[2], borderRadius: 8 }, hover(s), ring]}
    >
      {children}
      <Text variant="footnote" tone="brandText" style={{ fontWeight: '600' }}>
        Edit
      </Text>
    </Pressable>
  )
}

// One option on a phone: its name, then the figures it moved, each change with the figure it leads to; the baseline lists all of its figures.
const OptionCard = memo(function OptionCard({ row, columns, onRemove, onEdit }: CardProps) {
  const cells = cardCells(row)
  const note = NOTES[row.role]
  return (
    <Card style={{ gap: SPACE[3] }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[2] }}>
        <EditTarget row={row} onEdit={onEdit}>
          <Title row={row} variant="headline" />
          {note ? (
            <Text variant="footnote" tone="text2">
              {note}
            </Text>
          ) : null}
        </EditTarget>
        {row.lever !== null ? (
          <View style={{ marginRight: -SPACE[3], marginVertical: -SPACE[3] }}>
            <Button label={removeName(row)} icon="x" iconOnly variant="plain" onPress={() => onRemove(row.lever ?? -1)} />
          </View>
        ) : null}
      </View>
      {row.state === 'measuring' ? (
        <Text tone="text2">Measuring…</Text>
      ) : row.state === 'failed' ? (
        <Failed errors={row.errors} />
      ) : cells.length === 0 ? (
        <Text tone="text2">No figure moves.</Text>
      ) : (
        <View style={{ gap: SPACE[3] }}>
          {cells.map((cell, i) => (
            <View key={cell.column} style={{ gap: SPACE[3] }}>
              {i > 0 ? <Rule /> : null}
              <Line cell={cell} column={columns.find((c) => c.id === cell.column)} baseline={row.role === 'baseline'} />
            </View>
          ))}
        </View>
      )}
    </Card>
  )
})

function Failed({ errors }: { errors: readonly string[] }) {
  return (
    <View style={{ gap: SPACE[1] }}>
      <Pill tone="negative">Not measured</Pill>
      <Text variant="footnote" tone="text2">
        {errors.join(' ')}
      </Text>
    </View>
  )
}

function Line({ cell, column, baseline }: { cell: Cell; column: Column | undefined; baseline: boolean }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: SPACE[3], rowGap: SPACE[1] }}>
      <Text variant="subhead" tone="text2" style={{ flexGrow: 1, flexShrink: 1, flexBasis: 120 }}>
        {column?.title ?? ''}
      </Text>
      <View style={{ marginLeft: 'auto', alignItems: 'flex-end', gap: SPACE[1] }}>
        {baseline || !cell.change ? (
          <ValueText value={cell.value} variant="body" tone="text" />
        ) : (
          <>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: SPACE[2] }}>
              <VerdictPill verdict={cell.verdict} />
              <ChangeText change={cell.change} variant="body" tone="text" style={STRONG} />
            </View>
            <ValueText value={cell.value} variant="footnote" tone="text2" prefix="to " />
          </>
        )}
      </View>
    </View>
  )
}

// Each change's place as listed in the name, so two of one kind read apart in the order they are heard.
const removeName = (row: OptionRow) => `Remove change ${row.place ?? 0}: ${row.name}`

// From 1,024 px: every option a row and every figure a column, sorted as the cards are; it scrolls sideways inside its card when the columns outgrow the page.
function Table({ view, onRemove, onEdit, editable }: { view: CompareView; onRemove: (index: number) => void; onEdit: (index: number) => void; editable: (index: number | null) => boolean }) {
  const { colors } = useTheme()
  const locale = useLocale()
  const [width, setWidth] = useState(0)
  const widths = useMemo(() => columnWidths(view, locale), [view, locale])
  const figures = view.columns.reduce((sum, c) => sum + (widths[c.id] ?? 0), 0)
  // The names take what the figures leave, so they wrap rather than push the figures off the page.
  const labelWidth = Math.max(TABLE_LABEL_MIN, width - figures)
  const row: ViewStyle = { flexDirection: 'row', alignItems: 'stretch', minHeight: ROW_MIN_HEIGHT }
  const label: ViewStyle = { width: labelWidth, paddingLeft: GUTTER, paddingRight: SPACE[2], paddingVertical: SPACE[3] }
  const cell = (id: string): ViewStyle => ({ width: widths[id], paddingHorizontal: TABLE_CELL_PAD, paddingVertical: SPACE[3], alignItems: 'flex-end', gap: SPACE[1] })
  const sideways = width > 0 && labelWidth + figures > width
  return (
    <View style={{ gap: SPACE[2] }}>
      {sideways ? (
        <Text variant="footnote" tone="text2">
          Scroll the table sideways to see every figure.
        </Text>
      ) : null}
      <Card flush onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width) - 2 * LINE_WIDTH)}>
        <ScrollView horizontal>
          <View role="table" aria-label="Each change beside your plan" style={{ width: labelWidth + figures }}>
            <View role="row" style={[row, { minHeight: 44, backgroundColor: colors.surface2 }]}>
              <View style={[label, { justifyContent: 'flex-end' }]}>
                <Text role="columnheader" variant="footnote" tone="text2" style={STRONG}>
                  Change
                </Text>
              </View>
              {view.columns.map((c) => (
                <View key={c.id} style={[cell(c.id), { justifyContent: 'flex-end' }]}>
                  <Text role="columnheader" variant="footnote" tone={c.id === view.sort.id ? 'text' : 'text2'} style={[STRONG, { textAlign: 'right' }]}>
                    {c.short}
                  </Text>
                </View>
              ))}
            </View>
            {view.rows.map((r) => (
              <TableRow key={r.key} row={r} view={view} onRemove={onRemove} onEdit={editable(r.lever) ? onEdit : null} style={row} label={label} cell={cell} />
            ))}
          </View>
        </ScrollView>
      </Card>
    </View>
  )
}

interface TableRowProps {
  row: OptionRow
  view: CompareView
  onRemove: (index: number) => void
  onEdit: ((index: number) => void) | null
  style: ViewStyle
  label: ViewStyle
  cell: (id: string) => ViewStyle
}

function TableRow({ row, view, onRemove, onEdit, style, label, cell }: TableRowProps) {
  const { colors } = useTheme()
  const note = NOTES[row.role]
  return (
    <View role="row" style={[style, { borderTopWidth: LINE_WIDTH, borderTopColor: colors.line }]}>
      <View role="rowheader" style={[label, { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE[1] }]}>
        <EditTarget row={row} onEdit={onEdit}>
          <Title row={row} variant="subhead" />
          {note ? (
            <Text variant="footnote" tone="text2">
              {note}
            </Text>
          ) : null}
          {row.state === 'measuring' ? (
            <Text variant="footnote" tone="text2">
              Measuring…
            </Text>
          ) : row.state === 'failed' ? (
            <Failed errors={row.errors} />
          ) : null}
        </EditTarget>
        {row.lever !== null ? (
          <View style={{ marginTop: -SPACE[3], marginBottom: -SPACE[3] }}>
            <Button label={removeName(row)} icon="x" iconOnly variant="plain" onPress={() => onRemove(row.lever ?? -1)} />
          </View>
        ) : null}
      </View>
      {view.columns.map((c) => {
        const found = row.cells.find((x) => x.column === c.id)
        return (
          <View key={c.id} role="cell" style={cell(c.id)}>
            {!found ? null : row.role === 'baseline' ? (
              <ValueText value={found.value} variant="subhead" tone="text" />
            ) : found.change ? (
              <>
                <ChangeText change={found.change} variant="subhead" tone="text" style={STRONG} />
                <ValueText value={found.value} variant="footnote" tone="text2" />
                <VerdictPill verdict={found.verdict} />
              </>
            ) : (
              <Text variant="footnote" tone="text3">
                No change
              </Text>
            )}
          </View>
        )
      })}
    </View>
  )
}
