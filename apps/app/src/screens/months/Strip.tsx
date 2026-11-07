import { useCallback, useEffect, useMemo, useRef } from 'react'
import { FlatList, Platform, Pressable, useWindowDimensions, View, type GestureResponderEvent, type ListRenderItem, type PressableProps, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { plainClick } from '@/ui/TabBar'
import { Pill } from '@/ui/Pill'
import { Text } from '@/ui/Text'
import { useFocusRing, useLocale, useReduceMotion, useTheme } from '@/ui/theme'
import { SIDEBAR_MIN_WIDTH } from '@/shell/shell.model'
import { CONTENT_MAX_WIDTH, GUTTER, LINE_WIDTH, PICKED, RADII, SIDEBAR_WIDTH, SPACE, WORD_TONE } from '@/ui/tokens'
import { centreOffset, CHIP_GAP, chipFill, chipLabels, chipShown, chipWidth, NO_SCROLL, stripScroll, type Chip, type ChipLabel, type StripEvent } from './months.model'

const WEB = Platform.OS === 'web'

// Set just before a month change pushes the next Months screen, so its strip takes the focus the last one had.
export const stripFocus = { pending: false }

// Focus without scrolling the page: the strip centres the month by its own offset.
function focusQuietly(node: View | null | undefined) {
  if (!node) return
  if (WEB) (node as unknown as HTMLElement).focus({ preventScroll: true })
  else node.focus()
}

const STEP: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i, n) => Math.min(n - 1, i + 1),
  ArrowLeft: (i) => Math.max(0, i - 1),
  Home: () => 0,
  End: (_i, n) => n - 1,
}

export interface StripProps {
  chips: readonly Chip[]
  // The selected month; the strip centres it.
  month: string
  hrefOf: (month: string) => string
  onPick: (month: string) => void
}

// The month strip: one chip per month with its word, centred on the selected month by a single scroll of its own (rule 183).
export function Strip({ chips, month, hrefOf, onPick }: StripProps) {
  const locale = useLocale()
  const reduceMotion = useReduceMotion()
  const labels = useMemo(() => chipLabels(chips, locale), [chips, locale])
  const width = useMemo(() => chipWidth(labels), [labels])
  const list = useRef<FlatList<Chip>>(null)
  const plan = useRef(NO_SCROLL)
  const refs = useRef<(View | null)[]>([])
  const motion = useRef(reduceMotion)
  motion.current = reduceMotion
  // Where the strip is scrolled to; the web reads it from the page, which may drop it when the layout changes.
  const offset = useRef(0)
  // Edge to edge while the column fills the screen, as on phones; inside the column once it has margins of its own.
  const screen = useWindowDimensions().width
  const pad = (screen >= SIDEBAR_MIN_WIDTH ? screen - SIDEBAR_WIDTH : screen) - 2 * GUTTER <= CONTENT_MAX_WIDTH ? GUTTER : 0

  // The strip scrolls only here, by its own offset; never scrollIntoView, which also moves the page.
  const dispatch = useCallback(
    (event: StripEvent) => {
      const step = stripScroll(plan.current, event)
      plan.current = step.state
      if (!step.scroll) return
      const index = Math.max(0, chips.findIndex((c) => c.month === step.scroll?.month))
      const offset = centreOffset({ count: chips.length, chip: width, gap: CHIP_GAP, pad }, index, step.scroll.width)
      list.current?.scrollToOffset({ offset, animated: step.scroll.animated && !motion.current })
    },
    [chips, width, pad],
  )
  // The strip's width at its last layout, for a window resize that leaves it alone.
  const seen = useRef(0)
  const layout = (viewport: number) => {
    const node = WEB ? (list.current?.getScrollableNode() as { scrollLeft?: number } | undefined) : undefined
    const at = node?.scrollLeft ?? offset.current
    const index = chips.findIndex((c) => c.month === month)
    dispatch({ type: 'layout', width: viewport, screen, shows: index >= 0 && chipShown({ count: chips.length, chip: width, gap: CHIP_GAP, pad }, index, at, viewport) })
  }
  const onLayout = (viewport: number) => {
    seen.current = viewport
    layout(viewport)
  }
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  useEffect(() => dispatch({ type: 'select', month }), [dispatch, month])
  // Crossing the sidebar's width moves the strip in the page, which drops its offset without a layout of its own; check once the page has settled.
  useEffect(() => {
    if (seen.current <= 0) return
    const node = WEB ? (list.current?.getScrollableNode() as { clientWidth?: number } | undefined) : undefined
    const frame = requestAnimationFrame(() => layoutRef.current(node?.clientWidth || seen.current))
    return () => cancelAnimationFrame(frame)
  }, [screen])
  useEffect(() => {
    if (!stripFocus.pending) return
    stripFocus.pending = false
    focusQuietly(refs.current[chips.findIndex((c) => c.month === month)])
    // Once, on the screen a month change opened.
  }, [])

  // One tab stop: the arrow keys, Home and End move the focus along the strip, and Enter opens the focused month.
  const move = (from: number, key: string) => {
    const step = STEP[key]
    if (!step) return false
    refs.current[step(from, chips.length)]?.focus()
    return true
  }
  const renderItem: ListRenderItem<Chip> = ({ item, index }) => (
    <MonthChip
      chip={item}
      label={labels[index] as ChipLabel}
      width={width}
      last={index === chips.length - 1}
      selected={item.month === month}
      href={hrefOf(item.month)}
      onPress={() => onPick(item.month)}
      onKey={(key) => move(index, key)}
      setRef={(r) => (refs.current[index] = r)}
    />
  )
  return (
    <View style={{ marginHorizontal: -pad }}>
      <FlatList
        ref={list}
        horizontal
        data={chips}
        extraData={`${month} ${width}`}
        keyExtractor={(c) => c.month}
        renderItem={renderItem}
        getItemLayout={(_, index) => ({ length: width + CHIP_GAP, offset: pad + index * (width + CHIP_GAP), index })}
        // 73 small chips: all drawn at once, so a scroll never shows a blank stretch.
        initialNumToRender={chips.length}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: pad }}
        onScroll={(e) => (offset.current = e.nativeEvent.contentOffset.x)}
        scrollEventThrottle={16}
        onLayout={(e) => onLayout(e.nativeEvent.layout.width)}
      />
    </View>
  )
}

interface MonthChipProps {
  chip: Chip
  label: ChipLabel
  width: number
  last: boolean
  selected: boolean
  href: string
  onPress: () => void
  onKey: (key: string) => boolean
  setRef: (r: View | null) => void
}

function MonthChip({ chip, label, width, last, selected, href, onPress, onKey, setRef }: MonthChipProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const past = chip.kind === 'past'
  const semantics = (
    WEB
      ? { href, role: 'link', 'aria-current': selected ? 'page' : undefined, tabIndex: selected ? 0 : -1, onKeyDown: (e: { key: string; preventDefault: () => void }) => onKey(e.key) && e.preventDefault() }
      : { role: 'button', 'aria-selected': selected }
  ) as PressableProps
  const press = (e: GestureResponderEvent) => {
    if (!WEB || plainClick(e)) onPress()
  }
  const box = ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle => ({
    width,
    minHeight: 52,
    // The picked month's edge is twice as thick, its padding a point less, so nothing inside moves.
    paddingVertical: SPACE[2] - (selected ? LINE_WIDTH : 0),
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE[1],
    borderRadius: RADII.control,
    borderWidth: selected ? 2 * LINE_WIDTH : LINE_WIDTH,
    // This month keeps a Cobalt edge; the picked month a thicker one round a soft Cobalt fill, so each shows by shape as well as colour.
    borderColor: selected ? colors[PICKED.edge] : chip.kind === 'current' ? colors.brandText : colors.line,
    backgroundColor: colors[chipFill(chip.kind, selected, !!(hovered || pressed))],
  })
  return (
    <View style={{ width, marginRight: last ? 0 : CHIP_GAP, gap: SPACE[1] }}>
      <Text variant="caption" tone={label.above === 'Now' ? 'brandText' : 'text3'} numbers aria-hidden style={{ minHeight: 16 }}>
        {label.above}
      </Text>
      <Pressable ref={setRef} {...semantics} aria-label={label.label} onPress={press} onFocus={onFocus} onBlur={onBlur} style={(s) => [box(s), ring]}>
        <Text variant="subhead" tone={selected ? PICKED.label : past ? 'text2' : 'text'} style={{ fontWeight: '600' }}>
          {label.month}
        </Text>
        {chip.word ? (
          // The same pill as an account row's, on its own fill, so a word reads alike on every screen.
          <View style={{ alignSelf: 'center' }}>
            <Pill tone={WORD_TONE[chip.word]}>{chip.word}</Pill>
          </View>
        ) : (
          <Text variant="caption" tone="text3">
            {past ? 'Past' : ' '}
          </Text>
        )}
      </Pressable>
    </View>
  )
}
