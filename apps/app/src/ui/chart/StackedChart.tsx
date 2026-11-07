import { formatMoney } from '@waypoint/core'
import { useMemo, useState } from 'react'
import { Platform, ScrollView, View, type ViewProps } from 'react-native'
import Svg, { Line, Path, type SvgProps } from 'react-native-svg'
import { Button } from '../Button'
import { Text } from '../Text'
import { useMask, useTheme } from '../theme'
import { LINE_WIDTH, SPACE, SWATCH, TEXT_GAP } from '../tokens'
import { axisWidth } from './layout'
import { niceTicks } from './scale'

export interface StackedSeries {
  id: string
  label: string
  // The account's identity colour.
  colour: string
  // One value per point, never below zero.
  values: readonly number[]
  // The first point it is zero for good, or null while it still has a value at the last point.
  clears_at: number | null
}

export interface StackedChartProps {
  currency: string
  locale: string
  // Today, then the last day of each month.
  days: readonly string[]
  // Stacked bottom to top.
  series: readonly StackedSeries[]
  // Series ids in the order the legend and the table list them.
  order: readonly string[]
  // A dashed marker at a point, such as the month revolving balances clear.
  marker: { index: number; label: string } | null
  // A dashed line across at a value, such as the book a goal takes.
  level?: { value: number; label: string } | null
  // The takeaway, shown as the chart's heading, and a line under it.
  title: string
  subtitle: string
}

// The plot's band above the data for the marker's label, its height, and the row of month labels under it.
const TOP = 30
const PLOT = 120
const X_AXIS = 20
const AXIS_LINE = 13
const LABEL_WIDTH = 64
// Neighbouring areas never touch: each is outlined in the card's colour.
const AREA_STROKE = 1.5
const MARK_STROKE = 1.5

// The plot's parts are drawn for the eye; the image's label and the table carry them for screen readers.
const HIDDEN_SVG: SvgProps = Platform.OS === 'web' ? { 'aria-hidden': true } : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }
const HIDDEN_VIEW: ViewProps = Platform.OS === 'web' ? ({ 'aria-hidden': true } as ViewProps) : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }

const monthOf = (day: string) => day.slice(0, 7)

const monthWith = (day: string, locale: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(new Date(`${monthOf(day)}-01T00:00:00Z`))

// 'Apr 27' on the axis, so five fit at 320 pt; 'Apr 2027' in the table; 'April 2027' for screen readers.
export const axisMonth = (day: string, locale: string) => monthWith(day, locale, { month: 'short', year: '2-digit' })
const tableMonth = (day: string, locale: string) => monthWith(day, locale, { month: 'short', year: 'numeric' })
const spokenMonth = (day: string, locale: string) => monthWith(day, locale, { month: 'long', year: 'numeric' })

// Now, the last point, and up to two evenly between, so labels never crowd.
function labelPoints(length: number, slots: number): number[] {
  const last = length - 1
  const between = Math.max(0, Math.min(2, slots - 2, last - 1))
  return [...new Set([0, ...Array.from({ length: between }, (_, k) => Math.round(((k + 1) * last) / (between + 1))), last])]
}

// Spec §8 charts: stacked areas in each series' identity colour, outlined in the card's colour so neighbours never touch, with a dashed marker, a legend and a table.
export function StackedChart({ currency, locale, days, series, order, marker, level = null, title, subtitle }: StackedChartProps) {
  const { colors } = useTheme()
  const { masked } = useMask()
  const [width, setWidth] = useState(0)
  const [table, setTable] = useState(false)
  const n = days.length
  const totals = useMemo(() => days.map((_, k) => series.reduce((sum, s) => sum + (s.values[k] ?? 0), 0)), [days, series])
  const y = useMemo(() => niceTicks(0, Math.max(1, level?.value ?? 0, ...totals)), [totals, level])
  const format = (minor: number, compact = false) => formatMoney(minor, currency, locale, { mask: masked, compact })
  // The gutter is sized from unmasked labels, so the eye never moves the plot.
  const gutter = axisWidth(y.ticks.map((t) => formatMoney(t, currency, locale, { compact: true })))
  const plotWidth = Math.max(1, width - gutter)
  const xOf = (k: number) => gutter + (n <= 1 ? 0 : (k * plotWidth) / (n - 1))
  const yOf = (v: number) => TOP + PLOT - ((v - y.min) / Math.max(1, y.max - y.min)) * PLOT
  const end = days[n - 1] ?? ''
  const zero = (totals[n - 1] ?? 0) === 0
  const listed = order.flatMap((id) => series.filter((s) => s.id === id))
  const cleared = listed.filter((s) => s.clears_at !== null).sort((a, b) => (a.clears_at ?? 0) - (b.clears_at ?? 0))
  const summary = `Stacked areas. The total ${(totals[n - 1] ?? 0) > (totals[0] ?? 0) ? 'rises' : 'falls'} from ${format(totals[0] ?? 0)} now to ${zero ? `zero in ${spokenMonth(end, locale)}` : `${format(totals[n - 1] ?? 0)} in ${spokenMonth(end, locale)}`}. ${cleared.map((s) => `${s.label} clears in ${spokenMonth(days[s.clears_at ?? 0] ?? end, locale)}`).join(', ')}${cleared.length > 0 ? '.' : ''}${level ? ` ${level.label}.` : ''}`

  // Each area runs along its own top and back along the top of the one under it.
  const base = new Array<number>(n).fill(0)
  const areas = series.map((s) => {
    const top = base.map((b, k) => b + (s.values[k] ?? 0))
    const upper = top.map((v, k) => `${k === 0 ? 'M' : 'L'}${xOf(k).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ')
    const lower = base
      .map((v, k) => [k, v] as const)
      .reverse()
      .map(([k, v]) => `L${xOf(k).toFixed(1)},${yOf(v).toFixed(1)}`)
      .join(' ')
    top.forEach((v, k) => (base[k] = v))
    return { id: s.id, d: `${upper} ${lower} Z`, colour: s.colour }
  })

  const crisp = (v: number) => Math.round(v) + 0.5
  const mark = marker?.index ?? null
  const markX = mark === null ? 0 : xOf(mark)
  const markRight = markX + SPACE[1] + 96 > gutter + plotWidth
  return (
    <View style={{ gap: SPACE[2] }}>
      <View style={{ gap: TEXT_GAP }}>
        <Text variant="headline" level={3}>
          {title}
        </Text>
        <Text variant="footnote" tone="text2">
          {subtitle}
        </Text>
      </View>
      <View onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))} style={{ height: TOP + PLOT + X_AXIS }}>
        {width > 0 ? (
          <View role="img" aria-label={`${title}. ${summary}`} style={{ width, height: TOP + PLOT + X_AXIS }}>
            <Svg width={width} height={TOP + PLOT} {...HIDDEN_SVG}>
              {y.ticks.map((t) => (t === y.min ? null : <Line key={t} x1={gutter} x2={gutter + plotWidth} y1={crisp(yOf(t))} y2={crisp(yOf(t))} stroke={colors.line} strokeWidth={LINE_WIDTH} />))}
              {areas.map((a) => (
                <Path key={a.id} d={a.d} fill={a.colour} stroke={colors.surface} strokeWidth={AREA_STROKE} strokeLinejoin="round" />
              ))}
              <Line x1={gutter} x2={gutter + plotWidth} y1={crisp(yOf(y.min))} y2={crisp(yOf(y.min))} stroke={colors.controlBorder} strokeWidth={LINE_WIDTH} />
              {level ? <Line x1={gutter} x2={gutter + plotWidth} y1={crisp(yOf(level.value))} y2={crisp(yOf(level.value))} stroke={colors.text2} strokeWidth={MARK_STROKE} strokeDasharray="5 4" /> : null}
              {mark !== null ? <Line x1={markX} x2={markX} y1={TOP - SPACE[4]} y2={yOf(y.min)} stroke={colors.text2} strokeWidth={MARK_STROKE} strokeDasharray="3 3" /> : null}
            </Svg>
            <View {...HIDDEN_VIEW} style={{ position: 'absolute', left: 0, top: 0, width, height: TOP + PLOT + X_AXIS, pointerEvents: 'none' }}>
              {y.ticks.map((t) => (
                <Text key={t} variant="axis" tone="text3" numbers numberOfLines={1} style={{ position: 'absolute', left: 0, width: gutter - SPACE[2], top: yOf(t) - AXIS_LINE / 2, textAlign: 'right' }}>
                  {format(t, true)}
                </Text>
              ))}
              {level ? (
                <Text variant="caption" tone="text2" numberOfLines={1} style={{ position: 'absolute', left: gutter + SPACE[1], width: plotWidth / 2, top: yOf(level.value) - AXIS_LINE - SPACE[1] - 2 }}>
                  {level.label}
                </Text>
              ) : null}
              {marker ? (
                <Text variant="caption" tone="text2" style={[{ position: 'absolute', top: 0, width: 96 }, markRight ? { left: markX - SPACE[1] - 96, textAlign: 'right' } : { left: markX + SPACE[1] }]}>
                  {marker.label}
                </Text>
              ) : null}
              {labelPoints(n, Math.floor(plotWidth / LABEL_WIDTH)).map((k) => {
                const left = Math.max(0, Math.min(width - LABEL_WIDTH, xOf(k) - LABEL_WIDTH / 2))
                const align = k === 0 ? 'left' : k === n - 1 ? 'right' : 'center'
                return (
                  <Text key={k} variant="axis" tone="text3" numbers numberOfLines={1} style={{ position: 'absolute', top: TOP + PLOT + SPACE[1], left: k === 0 ? gutter : k === n - 1 ? width - LABEL_WIDTH : left, width: LABEL_WIDTH, textAlign: align }}>
                    {k === 0 ? 'Now' : axisMonth(days[k] ?? end, locale)}
                  </Text>
                )
              })}
            </View>
          </View>
        ) : null}
      </View>
      {/* The legend in the screen's own order, such as the cards below the chart. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE[4], rowGap: SPACE[1] }}>
        {listed.map((s) => (
          <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2] }}>
            <View style={{ width: SWATCH.size, height: SWATCH.size, borderRadius: SWATCH.radius, backgroundColor: s.colour }} />
            <Text variant="footnote" tone="text2">
              {s.label}
            </Text>
          </View>
        ))}
      </View>
      <View style={{ alignItems: 'flex-start', marginLeft: -SPACE[3] }}>
        <Button label={table ? 'Hide table' : 'View as table'} variant="plain" size="small" onPress={() => setTable(!table)} />
      </View>
      {table ? <ValueTable days={days} listed={listed} totals={totals} format={format} title={title} locale={locale} /> : null}
    </View>
  )
}

interface TableProps {
  days: readonly string[]
  listed: readonly StackedSeries[]
  totals: readonly number[]
  format: (minor: number) => string
  title: string
  locale: string
}

// Each point as a row: the month, each series' value and the total.
function ValueTable({ days, listed, totals, format, title, locale }: TableProps) {
  const { colors } = useTheme()
  const cell = { minWidth: 104, paddingVertical: SPACE[2], paddingLeft: SPACE[2], textAlign: 'right' } as const
  const row = { flexDirection: 'row', borderBottomWidth: LINE_WIDTH, borderColor: colors.line } as const
  return (
    <ScrollView horizontal>
      <View role="table" aria-label={title}>
        <View role="row" style={row}>
          <Text role="columnheader" variant="footnote" tone="text2" style={{ width: 88, paddingVertical: SPACE[2], fontWeight: '600' }}>
            Month
          </Text>
          {listed.map((s) => (
            <Text key={s.id} role="columnheader" variant="footnote" tone="text2" style={[cell, { fontWeight: '600' }]}>
              {s.label}
            </Text>
          ))}
          <Text role="columnheader" variant="footnote" tone="text2" style={[cell, { fontWeight: '600' }]}>
            Total
          </Text>
        </View>
        {days.map((day, k) => (
          <View key={day} role="row" style={row}>
            <Text role="rowheader" variant="footnote" tone="text2" numbers style={{ width: 88, paddingVertical: SPACE[2] }}>
              {k === 0 ? 'Now' : tableMonth(day, locale)}
            </Text>
            {listed.map((s) => (
              <Text key={s.id} role="cell" variant="footnote" numbers style={cell}>
                {format(s.values[k] ?? 0)}
              </Text>
            ))}
            <Text role="cell" variant="footnote" numbers style={[cell, { fontWeight: '600' }]}>
              {format(totals[k] ?? 0)}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  )
}
