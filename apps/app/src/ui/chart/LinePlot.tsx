import { daysBetween, formatMoney } from '@waypoint/core'
import { memo, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Platform, ScrollView, View, type GestureResponderEvent, type PointerEvent, type ScrollViewProps, type TextProps as RNTextProps, type ViewProps } from 'react-native'
import Svg, { Circle, Line, Path, Rect, type SvgProps } from 'react-native-svg'
import { Button } from '../Button'
import { Icon } from '../icons'
import { StatusText, Text } from '../Text'
import { TYPE, useFocusRing, useMask, useTheme } from '../theme'
import { iconNudge, LINE_WIDTH, SPACE, SWATCH as IDENTITY_SWATCH, type Palette } from '../tokens'

const SWATCH_RADIUS = IDENTITY_SWATCH.radius
import type { LineChartProps } from './LineChart'
import {
  CHART_GAP,
  LABEL_LINE_HEIGHT,
  READOUT_COLUMN_GAP,
  READOUT_DATE_HEIGHT,
  READOUT_PART_GAP,
  READOUT_ROW_GAP,
  READOUT_ROW_HEIGHT,
  SWATCH,
  AXIS_GAP,
  AXIS_LINE_HEIGHT,
  TABLE_FIRST_PAD,
  TABLE_VALUE_PAD,
  TOP_BAND,
  UNDER_FLOOR,
  X_AXIS_HEIGHT,
  readoutColumns,
  readoutHeight,
  tableColumns,
  type ReadoutFit,
} from './layout'
import { plotGeometry, tableOf, underFloor, type ChartTable, type PlotGeometry } from './plot'
import { dayAt, readoutDay, rowLabel, tickLabel, type ChartFloor, type ChartSeries } from './scale'
import { dragBy, fullRange, isZoomed, panBy, paneWindow, rangeEnds, shareAt, sliceView, wheelZoom, WHEEL_STEP, zoomAt, ZOOM_STEP, type DayRange } from './zoom'

export interface LinePlotProps extends LineChartProps {
  width: number
  height: number
  fit: ReadoutFit
}

type Format = (minor: number, compact?: boolean) => string

interface Scrub {
  // The pane's own day, which may lie outside the days in view.
  index: number
  // A tap on a zoomed chart reads its day until the next touch.
  via: 'touch' | 'mouse' | 'key' | 'tap'
}

// History stays at 3:1 against the past band; the band, not the stroke, says it is past.
const PAST_OPACITY = 0.7
const BAND_OPACITY = 0.2
const PAST_BAND_OPACITY = 0.12
const FLOOR_FILL_OPACITY = 0.24
const LINE_STROKE = 2
const AXIS_LABEL_WIDTH = 56
const MONEY_MARK = (Platform.OS === 'web' ? { dataSet: { money: '' } } : {}) as RNTextProps
// The plot's parts are drawn for the eye; the image's label, the readout and the table carry them for screen readers.
const HIDDEN_SVG: SvgProps = Platform.OS === 'web' ? { 'aria-hidden': true } : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }
const HIDDEN_VIEW: ViewProps = Platform.OS === 'web' ? ({ 'aria-hidden': true } as ViewProps) : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }

const KEYS: Record<string, (i: number, last: number, shift: boolean) => number> = {
  ArrowLeft: (i, _l, shift) => i - (shift ? 7 : 1),
  ArrowRight: (i, _l, shift) => i + (shift ? 7 : 1),
  PageUp: (i) => i - 30,
  PageDown: (i) => i + 30,
  Home: () => 0,
  End: (_i, last) => last,
}

export function LinePlot({ series, floors, startDate, todayIndex, currency, locale, title, summary, width, height, fit, zoom }: LinePlotProps) {
  const { colors } = useTheme()
  const { masked } = useMask()
  const length = Math.max(1, ...series.map((s) => s.points.length))
  const offset = zoom ? daysBetween(zoom.days.start, startDate) : 0
  const zoomed = zoom ? isZoomed(zoom.range, zoom.days.last) : false
  const { from, to } = zoom && zoomed ? paneWindow(zoom.range, offset, length) : fullRange(length - 1)
  // Zoomed, the days in view draw as a pane of their own: lines, floors, today, the date axis and the table.
  const view = useMemo(
    () => (from === 0 && to === length - 1 ? { series, floors, startDate, todayIndex } : sliceView({ series, floors, startDate, todayIndex }, { from, to })),
    [series, floors, startDate, todayIndex, from, to, length],
  )
  // The gutter is sized from unmasked labels, so the eye never moves the plot.
  const geo = useMemo(
    () => plotGeometry({ ...view, width, height, axisText: (minor) => formatMoney(minor, currency, locale, { compact: true }) }),
    [view, width, height, currency, locale],
  )
  const format = useMemo<Format>(() => (minor, compact = false) => formatMoney(minor, currency, locale, { mask: masked, compact }), [currency, locale, masked])
  const [scrub, setScrub] = useState<Scrub | null>(null)
  const [table, setTable] = useState(false)
  const rest = Math.max(from, Math.min(to, todayIndex))
  const held = scrub && scrub.index >= from && scrub.index <= to ? scrub : null
  const index = held?.index ?? rest
  const ends = zoom && zoomed ? rangeEnds(zoom.days, { from: from + offset, to: to + offset }, locale) : null
  const label = `${title}. ${summary}${ends ? ` Showing ${ends[0]} to ${ends[1]}.` : ''} Use the arrow keys to read each day${zoom ? ', plus and minus to zoom' : ''}.`
  const paneZoom = zoom ? { range: zoom.range, last: zoom.days.last, offset, length, set: zoom.onRange } : null
  return (
    <View style={{ gap: CHART_GAP }}>
      <Readout series={view.series} floors={view.floors} startDate={view.startDate} index={index - from} todayIndex={view.todayIndex} locale={locale} format={format} width={width} fit={fit} live={held?.via === 'key'} />
      <View style={{ width, height }}>
        <Drawing geo={geo} colors={colors} />
        <Labels geo={geo} width={width} format={format} colors={colors} />
        <Cursor geo={geo} series={view.series} index={held ? index - from : null} colors={colors} />
        <Scrubber geo={geo} from={from} rest={rest} label={label} held={held} setScrub={setScrub} zoom={paneZoom} />
      </View>
      <XAxis geo={geo} width={width} locale={locale} />
      {/* Pulled left by the button's padding, so its word lines up with the chart. */}
      <View style={{ alignItems: 'flex-start', marginLeft: -SPACE[3] }}>
        <Button label={table ? 'Hide table' : 'View as table'} variant="plain" size="small" onPress={() => setTable(!table)} />
      </View>
      {table ? <DataTable series={view.series} startDate={view.startDate} currency={currency} locale={locale} format={format} title={title} width={width} /> : null}
    </View>
  )
}

// The static layer: past band, gridlines, the soft fill under each floor, the lines, the floors and the today rule. Scrubbing never redraws it.
const Drawing = memo(function Drawing({ geo, colors }: { geo: PlotGeometry; colors: Palette }) {
  const crisp = (y: number) => Math.round(y) + 0.5
  const right = geo.plotLeft + geo.plotWidth
  return (
    <Svg width={right} height={geo.height} style={{ position: 'absolute', left: 0, top: 0 }} {...HIDDEN_SVG}>
      {geo.pastTo !== null ? <Rect x={geo.plotLeft} y={0} width={geo.pastTo - geo.plotLeft} height={geo.height} fill={colors.surface2} /> : null}
      {geo.y.ticks.map((t) => (
        <Line key={t} x1={geo.plotLeft} x2={right} y1={crisp(geo.yOf(t))} y2={crisp(geo.yOf(t))} stroke={colors.line} strokeWidth={LINE_WIDTH} />
      ))}
      {geo.lines.map((l) => (l.past_band ? <Path key={`${l.id}:past-band`} d={l.past_band} fill={l.colour} fillOpacity={PAST_BAND_OPACITY} /> : null))}
      {geo.lines.map((l) => (l.future_band ? <Path key={`${l.id}:future-band`} d={l.future_band} fill={l.colour} fillOpacity={BAND_OPACITY} /> : null))}
      {geo.floors.map((f) => f.fills.map((d, i) => <Path key={`${f.key}:${i}`} d={d} fill={f.colour} fillOpacity={FLOOR_FILL_OPACITY} />))}
      {geo.lines.map((l) => (l.past ? <Path key={`${l.id}:past`} d={l.past} fill="none" stroke={l.colour} strokeOpacity={PAST_OPACITY} strokeWidth={LINE_STROKE} strokeLinejoin="round" strokeLinecap="round" /> : null))}
      {geo.lines.map((l) => (l.future ? <Path key={`${l.id}:future`} d={l.future} fill="none" stroke={l.colour} strokeWidth={LINE_STROKE} strokeLinejoin="round" strokeLinecap="round" /> : null))}
      {geo.floors.map((f) => (
        <Line key={f.key} x1={f.x0} x2={f.x1} y1={f.y} y2={f.y} stroke={f.colour} strokeWidth={1.5} strokeDasharray="5 4" />
      ))}
      {geo.today !== null ? <Line x1={Math.round(geo.today) + 0.5} x2={Math.round(geo.today) + 0.5} y1={0} y2={geo.height} stroke={colors.text3} strokeWidth={LINE_WIDTH} /> : null}
    </Svg>
  )
})

// Words on the plot: amounts in the gutter beside their gridlines, Past and Today, one warning icon per account at its lowest dip, and the names column: each account at its line's end, its floor under it.
const Labels = memo(function Labels({ geo, width, format, colors }: { geo: PlotGeometry; width: number; format: Format; colors: Palette }) {
  const todayRight = geo.today !== null && geo.today + SPACE[1] + 40 > geo.plotLeft + geo.plotWidth
  return (
    <View style={{ position: 'absolute', left: 0, top: 0, width, height: geo.height, pointerEvents: 'none' }} {...HIDDEN_VIEW}>
      {geo.y.ticks.map((t) => (
        <Text
          key={t}
          {...MONEY_MARK}
          variant="axis"
          tone="text3"
          numbers
          numberOfLines={1}
          style={{ position: 'absolute', left: 0, width: geo.plotLeft - AXIS_GAP, top: geo.yOf(t) - AXIS_LINE_HEIGHT / 2, textAlign: 'right' }}
        >
          {format(t, true)}
        </Text>
      ))}
      {geo.today !== null && geo.pastTo !== null && geo.pastTo - geo.plotLeft >= 40 && !todayRight ? (
        <Text variant="caption" tone="text3" style={{ position: 'absolute', top: 0, right: width - geo.today + SPACE[1] }}>
          Past
        </Text>
      ) : null}
      {geo.today !== null ? (
        <Text variant="caption" tone="text2" style={[{ position: 'absolute', top: 0, fontWeight: '600' }, todayRight ? { right: width - geo.today + SPACE[1] } : { left: geo.today + SPACE[1] }]}>
          Today
        </Text>
      ) : null}
      {geo.floors.flatMap((f) =>
        f.icons.map((x) => (
          <View key={`${f.key}:${x}`} style={{ position: 'absolute', left: x - 8, top: f.y - 8, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }}>
            <Icon name="triangle-alert" size={12} color={colors.caution} />
          </View>
        )),
      )}
      {geo.labels.map((l) => (
        <View key={l.key} style={{ position: 'absolute', left: geo.labelColumn.x, top: l.top, width: geo.labelColumn.width }}>
          <View style={{ flexDirection: 'row', gap: SPACE[1] }}>
            <View style={{ width: SWATCH, height: SWATCH, borderRadius: SWATCH_RADIUS, marginTop: (LABEL_LINE_HEIGHT - SWATCH) / 2, backgroundColor: l.colour }} />
            <Text variant="caption" tone="text2" style={{ flexShrink: 1 }}>
              {l.text}
            </Text>
          </View>
          {l.floor ? (
            <View style={{ flexDirection: 'row', gap: SPACE[1] }}>
              <Svg width={SWATCH} height={LABEL_LINE_HEIGHT}>
                <Line x1={0} x2={SWATCH} y1={LABEL_LINE_HEIGHT / 2} y2={LABEL_LINE_HEIGHT / 2} stroke={l.colour} strokeWidth={1.5} strokeDasharray="3 2" />
              </Svg>
              <Text variant="caption" tone="text2">
                floor
              </Text>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  )
})

const Cursor = memo(function Cursor({ geo, series, index, colors }: { geo: PlotGeometry; series: readonly ChartSeries[]; index: number | null; colors: Palette }) {
  if (index === null) return null
  const x = geo.xOf(index)
  // A View carries pointerEvents: react-native-svg reads it only as a prop, which react-native-web no longer takes.
  return (
    <View style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} {...HIDDEN_VIEW}>
      <Svg width={geo.plotLeft + geo.plotWidth} height={geo.height}>
        <Line x1={x} x2={x} y1={TOP_BAND} y2={geo.bottom} stroke={colors.text2} strokeWidth={LINE_WIDTH} />
        {series.map((s) =>
          index < s.points.length ? <Circle key={s.id} cx={x} cy={geo.yOf(s.points[index] as number)} r={4} fill={s.colour} stroke={colors.surface} strokeWidth={1.5} /> : null,
        )}
      </Svg>
    </View>
  )
})

// One chart's view as a pane's gestures see it: the shared range, the chart's last day, and the pane's place in the chart's days.
interface PaneZoom {
  range: DayRange
  last: number
  offset: number
  length: number
  set: (range: DayRange) => void
}

interface ScrubberProps {
  geo: PlotGeometry
  // The pane's day at the plot's left edge.
  from: number
  rest: number
  label: string
  held: Scrub | null
  setScrub: Dispatch<SetStateAction<Scrub | null>>
  zoom: PaneZoom | null
}

// A finger moves this far before a touch counts as a drag; held this long without moving, it reads days instead.
const SLOP = 8
const HOLD_MS = 300

// scrub reads days and lets go on release; read is a held finger on a zoomed chart, whose day stays; scroll leaves the page to the browser.
type Gesture =
  | { kind: 'scrub' | 'read'; x0: number; horizontal: boolean }
  | { kind: 'wait'; x0: number; y0: number; start: DayRange }
  | { kind: 'pan'; x0: number; start: DayRange }
  | { kind: 'pinch'; d0: number; at0: number; start: DayRange }
  | { kind: 'scroll' }

interface Spot {
  x: number
  y: number
}

// + and − zoom (= and _ share their keys, U+2212 is the minus sign); 0 shows every day.
const ZOOM_KEYS = new Map<string, number | null>([
  ['+', ZOOM_STEP],
  ['=', ZOOM_STEP],
  ['-', 1 / ZOOM_STEP],
  ['_', 1 / ZOOM_STEP],
  ['\u2212', 1 / ZOOM_STEP],
  ['0', null],
])

const sameRange = (a: DayRange | null, b: DayRange) => a !== null && a.from === b.from && a.to === b.to

// The whole plot is the scrub target: drag or hover to read a day, arrow keys on the web. Zoomed, two fingers pinch and one pans; a tap or a held finger reads. A vertical swipe still scrolls the page.
function Scrubber({ geo, from, rest, label, held, setScrub, zoom }: ScrubberProps) {
  const { ring, onFocus, onBlur } = useFocusRing()
  const node = useRef<View>(null)
  const gesture = useRef<Gesture | null>(null)
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The plot's corner in page coordinates, so every finger's place comes from its pageX and pageY.
  const origin = useRef<Spot>({ x: 0, y: 0 })
  const pointer = useRef<string>('touch')
  const wheel = useRef<{ start: DayRange; at: number; x: number; total: number; time: number } | null>(null)
  const [grabbing, setGrabbing] = useState(false)
  // Events can outrun renders, so gestures read the range they last set.
  const range = useRef<DayRange | null>(null)
  range.current = zoom?.range ?? null
  const zoomed = zoom !== null && isZoomed(zoom.range, zoom.last)
  const setRange = (next: DayRange) => {
    if (!zoom || sameRange(range.current, next)) return
    range.current = next
    zoom.set(next)
  }
  const show = (index: number, via: Scrub['via']) => setScrub((s) => (s && s.index === index && s.via === via ? s : { index, via }))
  const dayAtX = (x: number) => from + geo.indexAt(x)
  const spots = (e: GestureResponderEvent): Spot[] => Array.from(e.nativeEvent.touches ?? [], (t) => ({ x: t.pageX - origin.current.x, y: t.pageY - origin.current.y }))
  const stopHold = () => {
    if (hold.current) clearTimeout(hold.current)
    hold.current = null
  }
  useEffect(() => stopHold, [])
  const pinch = (a: Spot, b: Spot) => ({ d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), at: shareAt((a.x + b.x) / 2, geo.plotLeft, geo.plotWidth) })
  const startPinch = (spot: Spot[]) => {
    const r = range.current
    const [a, b] = spot
    if (!r || !a || !b) return
    stopHold()
    const p = pinch(a, b)
    gesture.current = { kind: 'pinch', d0: p.d, at0: p.at, start: r }
    setScrub((s) => (s?.via === 'mouse' ? s : null))
  }
  const startPan = (x: number) => {
    const r = range.current
    gesture.current = r ? { kind: 'pan', x0: x, start: r } : null
  }
  const end = (released: boolean) => {
    const g = gesture.current
    stopHold()
    gesture.current = null
    setGrabbing(false)
    if (released && g?.kind === 'wait') return show(dayAtX(g.x0), 'tap')
    if (released && g?.kind === 'read') return setScrub((s) => (s ? { ...s, via: 'tap' } : s))
    if (pointer.current !== 'mouse') setScrub((s) => (s?.via === 'tap' ? s : null))
  }
  // Zoom keys centre on the day being read, or on the middle of the view.
  const keyZoom = (factor: number | null) => {
    const r = range.current
    if (!zoom || !r) return
    if (factor === null) return setRange(fullRange(zoom.last))
    const day = held ? held.index + zoom.offset : null
    setRange(zoomAt(r, factor, day !== null && r.to > r.from ? Math.max(0, Math.min(1, (day - r.from) / (r.to - r.from))) : 0.5, zoom.last))
  }
  const onWheel = useRef<(e: WheelEvent, box: DOMRect) => void>(() => {})
  // Ctrl and the wheel, or a trackpad pinch, zoom around the pointer; a plain wheel scrolls the page.
  onWheel.current = (e, box) => {
    const r = range.current
    if (!e.ctrlKey || !zoom || !r) return
    e.preventDefault()
    const x = e.clientX - box.left
    let run = wheel.current
    if (!run || e.timeStamp - run.time > 250 || Math.abs(x - run.x) > SLOP) run = wheel.current = { start: r, at: shareAt(x, geo.plotLeft, geo.plotWidth), x, total: 0, time: e.timeStamp }
    run.time = e.timeStamp
    const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY
    const next = wheelZoom(run.start, run.total + Math.max(-WHEEL_STEP, Math.min(WHEEL_STEP, px)), run.at, zoom.last)
    run.total = next.total
    setRange(next.range)
  }
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const el = node.current as unknown as HTMLElement | null
    if (!el) return
    const onWheelEvent = (e: WheelEvent) => onWheel.current(e, el.getBoundingClientRect())
    // Only a pinch, a pan or a held finger keeps the page still; a vertical swipe is never stopped.
    const onTouchMove = (e: TouchEvent) => {
      const kind = gesture.current?.kind
      if (e.cancelable && (e.touches.length > 1 || kind === 'pinch' || kind === 'pan' || kind === 'read')) e.preventDefault()
    }
    const stop = (e: Event) => e.preventDefault()
    el.addEventListener('wheel', onWheelEvent, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    // Safari's own pinch event would zoom the page.
    el.addEventListener('gesturestart', stop)
    return () => {
      el.removeEventListener('wheel', onWheelEvent)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('gesturestart', stop)
    }
  }, [])
  const web =
    Platform.OS === 'web'
      ? ({
          tabIndex: 0,
          onPointerDown: (e: PointerEvent) => (pointer.current = e.nativeEvent.pointerType),
          onPointerMove: (e: PointerEvent) => {
            pointer.current = e.nativeEvent.pointerType
            if (pointer.current !== 'mouse') return
            const box = (e.currentTarget as unknown as Element).getBoundingClientRect()
            show(dayAtX(e.nativeEvent.clientX - box.left), 'mouse')
          },
          onPointerLeave: () => setScrub((s) => (s?.via === 'mouse' ? null : s)),
          onKeyDown: (e: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
            if (e.key === 'Escape') return setScrub(null)
            const factor = ZOOM_KEYS.get(e.key)
            if (zoom && factor !== undefined) {
              e.preventDefault()
              return keyZoom(factor)
            }
            const r = range.current
            if (zoom && r && zoomed && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
              e.preventDefault()
              const next = panBy(r, Math.max(1, Math.round((r.to - r.from) / 4)) * (e.key === 'ArrowLeft' ? -1 : 1), zoom.last)
              setRange(next)
              // A day being read by key moves into the new view, so the next arrow steps from where it shows.
              const [lo, hi] = [Math.max(0, next.from - zoom.offset), Math.min(zoom.length - 1, next.to - zoom.offset)]
              return setScrub((s) => (s?.via === 'key' ? { index: Math.max(lo, Math.min(hi, s.index)), via: 'key' } : s))
            }
            const step = KEYS[e.key]
            if (!step) return
            e.preventDefault()
            const last = zoom ? zoom.length - 1 : geo.length - 1
            const index = Math.max(0, Math.min(last, step(held?.index ?? rest, last, e.shiftKey)))
            setScrub({ index, via: 'key' })
            // Zoomed, the view follows a day read past its edge.
            const day = zoom ? index + zoom.offset : 0
            if (zoom && r && (day < r.from || day > r.to)) setRange(panBy(r, day < r.from ? day - r.from : day - r.to, zoom.last))
          },
        } as Partial<ViewProps>)
      : {}
  return (
    <View
      ref={node}
      role="img"
      aria-label={label}
      {...web}
      onFocus={onFocus}
      onBlur={() => {
        onBlur()
        setScrub((s) => (s?.via === 'key' ? null : s))
      }}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        const { pageX, pageY, locationX, locationY } = e.nativeEvent
        origin.current = { x: pageX - locationX, y: pageY - locationY }
        const spot = spots(e)
        if (spot.length > 1 && zoom) return startPinch(spot)
        const mouse = pointer.current === 'mouse'
        const r = range.current
        if (zoom && r && isZoomed(r, zoom.last)) {
          if (mouse) {
            setGrabbing(true)
            return startPan(locationX)
          }
          setScrub((s) => (s?.via === 'tap' ? null : s))
          gesture.current = { kind: 'wait', x0: locationX, y0: locationY, start: r }
          stopHold()
          hold.current = setTimeout(() => {
            hold.current = null
            const g = gesture.current
            if (g?.kind !== 'wait') return
            gesture.current = { kind: 'read', x0: g.x0, horizontal: true }
            show(dayAtX(g.x0), 'touch')
          }, HOLD_MS)
          return
        }
        gesture.current = { kind: 'scrub', x0: locationX, horizontal: false }
        show(dayAtX(locationX), mouse ? 'mouse' : 'touch')
      }}
      onResponderStart={(e) => {
        const spot = spots(e)
        if (spot.length > 1 && zoom && gesture.current?.kind !== 'pinch') startPinch(spot)
      }}
      onResponderMove={(e) => {
        const spot = spots(e)
        const g = gesture.current
        if (spot.length > 1 && zoom) {
          if (g?.kind !== 'pinch') return startPinch(spot)
          const p = pinch(spot[0] as Spot, spot[1] as Spot)
          return setRange(zoomAt(g.start, p.d / g.d0, g.at0, zoom.last, p.at))
        }
        const s = spot[0]
        if (!s || !g) return
        if (g.kind === 'pinch') return startPan(s.x)
        if (g.kind === 'wait') {
          const [dx, dy] = [s.x - g.x0, s.y - g.y0]
          if (Math.max(Math.abs(dx), Math.abs(dy)) <= SLOP) return
          stopHold()
          if (Math.abs(dy) >= Math.abs(dx)) {
            gesture.current = { kind: 'scroll' }
            return
          }
          gesture.current = { kind: 'pan', x0: g.x0, start: g.start }
          if (zoom) setRange(dragBy(g.start, dx, geo.plotWidth, zoom.last))
          return
        }
        if (g.kind === 'pan') {
          if (zoom) setRange(dragBy(g.start, s.x - g.x0, geo.plotWidth, zoom.last))
          return
        }
        if (g.kind === 'scrub' || g.kind === 'read') {
          if (Math.abs(s.x - g.x0) > SLOP) g.horizontal = true
          show(dayAtX(s.x), pointer.current === 'mouse' ? 'mouse' : 'touch')
        }
      }}
      onResponderEnd={(e) => {
        // One finger of a pinch lifts: the other pans on from where it is.
        const spot = spots(e)
        if (gesture.current?.kind === 'pinch' && spot.length === 1) startPan((spot[0] as Spot).x)
      }}
      onResponderTerminationRequest={() => {
        const g = gesture.current
        return !(g && (g.kind === 'pan' || g.kind === 'pinch' || ((g.kind === 'scrub' || g.kind === 'read') && g.horizontal)))
      }}
      onResponderRelease={() => end(true)}
      onResponderTerminate={() => end(false)}
      style={[
        { position: 'absolute', left: 0, top: 0, width: geo.plotLeft + geo.plotWidth, height: geo.height, borderRadius: 4 },
        Platform.OS === 'web' ? ({ cursor: zoomed ? (grabbing ? 'grabbing' : 'grab') : 'crosshair', touchAction: 'pan-y', userSelect: 'none' } as object) : null,
        ring,
      ]}
    />
  )
}

interface ReadoutProps {
  series: readonly ChartSeries[]
  floors: readonly ChartFloor[]
  startDate: string
  index: number
  todayIndex: number
  locale: string
  format: Format
  width: number
  fit: ReadoutFit
  live: boolean
}

// Pinned above the plot at a fixed height: the day and each account's balance that day, today's when nothing is held.
const Readout = memo(function Readout({ series, floors, startDate, index, todayIndex, locale, format, width, fit, live }: ReadoutProps) {
  const columns = readoutColumns(width, fit)
  const when = index === todayIndex ? 'Today' : index < todayIndex ? 'Past' : 'Projected'
  return (
    <View style={{ height: readoutHeight(width, fit), gap: READOUT_ROW_GAP }} aria-live={live ? 'polite' : 'off'}>
      <Text variant="footnote" tone="text2" numbers numberOfLines={1} style={{ height: READOUT_DATE_HEIGHT, fontWeight: '600' }}>
        {`${readoutDay(dayAt(startDate, index), locale)} · ${when}`}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: READOUT_ROW_GAP }}>
        {series.map((s) => {
          const value = index < s.points.length ? (s.points[index] as number) : null
          const under = value !== null && underFloor(floors, s.account_id, index, value)
          return (
            <View key={s.id} style={{ width: `${100 / columns}%`, height: READOUT_ROW_HEIGHT, paddingRight: columns > 1 ? READOUT_COLUMN_GAP : 0, flexDirection: 'row', alignItems: 'center', gap: READOUT_PART_GAP }}>
              <View style={{ width: SWATCH, height: SWATCH, borderRadius: SWATCH_RADIUS, backgroundColor: s.colour }} />
              {/* One column reads as a table, amounts flush right; side by side, each amount stays beside its own name. */}
              <Text variant="footnote" tone="text2" numberOfLines={1} style={columns > 1 ? { flexShrink: 1 } : { flex: 1 }}>
                {s.label}
              </Text>
              {under ? (
                <StatusText tone="caution" variant="caption">
                  {UNDER_FLOOR}
                </StatusText>
              ) : null}
              <Text {...MONEY_MARK} variant="subhead" numbers>
                {value === null ? '–' : format(value)}
              </Text>
            </View>
          )
        })}
      </View>
    </View>
  )
})

const XAxis = memo(function XAxis({ geo, width, locale }: { geo: PlotGeometry; width: number; locale: string }) {
  const max = width - AXIS_LABEL_WIDTH
  return (
    <View style={{ height: X_AXIS_HEIGHT, width }} {...HIDDEN_VIEW}>
      {geo.xTicks.map((t) => {
        const left = Math.max(0, Math.min(max, t.x - AXIS_LABEL_WIDTH / 2))
        return (
          <Text
            key={t.index}
            variant="axis"
            tone="text3"
            numbers
            numberOfLines={1}
            style={{ position: 'absolute', top: SPACE[1], left, width: AXIS_LABEL_WIDTH, textAlign: left === 0 ? 'left' : left === max ? 'right' : 'center' }}
          >
            {tickLabel(t, locale)}
          </Text>
        )
      })}
    </View>
  )
})

function caption(table: ChartTable, locale: string): string {
  if (table.unit === 'month') return 'Lowest balance in each month.'
  const first = table.rows[0]?.day
  const last = table.rows.at(-1)?.day
  if (!first || !last) return 'Balance at the end of each day.'
  const month = (day: string) => rowLabel(day, 'month', locale)
  return `Balance at the end of each day, ${first.slice(0, 7) === last.slice(0, 7) ? month(first) : `${month(first)} to ${month(last)}`}.`
}

interface DataTableProps {
  series: readonly ChartSeries[]
  startDate: string
  currency: string
  locale: string
  format: Format
  title: string
  width: number
}

function DataTable({ series, startDate, currency, locale, format, title, width }: DataTableProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const table = useMemo(() => tableOf(series, startDate), [series, startDate])
  // Sized from unmasked text, so the eye never moves a column.
  const columns = useMemo(() => {
    let [lo, hi] = [0, 0]
    for (const r of table.rows) for (const v of r.values) if (v !== null) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)]
    const longest = (list: string[]) => list.reduce((a, b) => (b.length > a.length ? b : a), '')
    return tableColumns(
      width,
      longest(table.rows.map((r) => rowLabel(r.day, table.unit, locale))),
      longest([formatMoney(lo, currency, locale), formatMoney(hi, currency, locale)]),
      series.map((s) => s.label),
    )
  }, [table, series, currency, locale, width])
  const row = { flexDirection: 'row', borderBottomWidth: LINE_WIDTH, borderColor: colors.line } as const
  const first = { width: columns.first, paddingVertical: SPACE[2], paddingRight: TABLE_FIRST_PAD }
  const value = { width: columns.value, paddingVertical: SPACE[2], paddingLeft: TABLE_VALUE_PAD }
  return (
    <View style={{ gap: SPACE[2] }}>
      <Text variant="footnote" tone="text2">
        {caption(table, locale)}
        {columns.scrolls ? ' Scroll sideways to see every account.' : ''}
      </Text>
      {/* A table wider than the card is a scroll region the keyboard can reach. */}
      <ScrollView horizontal {...(columns.scrolls ? ({ tabIndex: 0, role: 'region', 'aria-label': `${title}, table`, onFocus, onBlur } as ScrollViewProps) : null)} style={columns.scrolls ? ring : null}>
        <View role="table" aria-label={title}>
          <View role="row" style={row}>
            <Text role="columnheader" variant="footnote" tone="text2" style={[first, { fontWeight: '600' }]}>
              {table.unit === 'day' ? 'Day' : 'Month'}
            </Text>
            {series.map((s) => (
              <View key={s.id} role="columnheader" style={[value, { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE[1] }]}>
                <View style={{ width: SWATCH, height: SWATCH, borderRadius: SWATCH_RADIUS, marginTop: iconNudge(TYPE.footnote.lineHeight, SWATCH), backgroundColor: s.colour }} />
                <Text variant="footnote" tone="text2" style={{ flexShrink: 1, textAlign: 'right', fontWeight: '600' }}>
                  {s.label}
                </Text>
              </View>
            ))}
          </View>
          {table.rows.map((r) => (
            <View key={r.day} role="row" style={row}>
              <Text role="rowheader" variant="footnote" tone="text2" numbers style={first}>
                {rowLabel(r.day, table.unit, locale)}
              </Text>
              {r.values.map((v, k) => (
                <Text key={series[k]?.id ?? k} role="cell" {...MONEY_MARK} variant="footnote" numbers style={[value, { textAlign: 'right' }]}>
                  {v === null ? '–' : format(v)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}
