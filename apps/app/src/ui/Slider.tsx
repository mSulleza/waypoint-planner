import { useEffect, useRef, useState } from 'react'
import { Platform, View, type AccessibilityActionEvent, type GestureResponderEvent, type ViewProps, type ViewStyle } from 'react-native'
import { Text } from './Text'
import { MIN_TARGET, useFocusRing, useTheme } from './theme'
import { SPACE, TEXT_GAP } from './tokens'

export interface SliderProps {
  // The visible name above the track, which is also the slider's name.
  label: string
  value: number
  min: number
  max: number
  step: number
  // The value as read: '€1,000 a month', '15% a year'.
  format: (value: number) => string
  // Live while dragging, at most once a frame; then onCommit once on release, a key or a screen-reader swipe.
  onChange: (value: number) => void
  onCommit: (value: number) => void
  note?: string
}

const TRACK = 4
const THUMB = 22
const THUMB_EDGE = 3

const KEYS: Record<string, (v: number, step: number, min: number, max: number) => number> = {
  ArrowRight: (v, s) => v + s,
  ArrowUp: (v, s) => v + s,
  ArrowLeft: (v, s) => v - s,
  ArrowDown: (v, s) => v - s,
  PageUp: (v, s) => v + 10 * s,
  PageDown: (v, s) => v - 10 * s,
  Home: (_v, _s, min) => min,
  End: (_v, _s, _min, max) => max,
}

// The web lets the page scroll up and down from the track, and hands a sideways drag to the slider.
const WEB_TRACK = (Platform.OS === 'web' ? { touchAction: 'pan-y', cursor: 'pointer', userSelect: 'none' } : {}) as ViewStyle

// A slider with one tab stop: drag or tap the track, arrow keys move a step, Page keys ten, Home and End the ends; screen readers swipe it a step.
export function Slider({ label, value, min, max, step, format, onChange, onCommit, note }: SliderProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const [width, setWidth] = useState(0)
  const drag = useRef({ x0: 0, last: value, frame: null as number | null })
  useEffect(() => () => cancel(drag.current.frame), [])
  const snap = (v: number) => Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step))
  const shown = Math.min(max, Math.max(min, value))
  const travel = Math.max(1, width - THUMB)
  const offset = max > min ? ((shown - min) / (max - min)) * travel : 0
  const at = (pageX: number) => snap(min + ((pageX - drag.current.x0 - THUMB / 2) / travel) * (max - min))
  const live = (v: number) => {
    if (v === drag.current.last) return
    drag.current.last = v
    if (drag.current.frame === null)
      drag.current.frame = frame(() => {
        drag.current.frame = null
        onChange(drag.current.last)
      })
  }
  const done = () => {
    cancel(drag.current.frame)
    drag.current.frame = null
    onChange(drag.current.last)
    onCommit(drag.current.last)
  }
  const jump = (v: number) => {
    const next = snap(v)
    if (next === shown) return
    drag.current.last = next
    onChange(next)
    onCommit(next)
  }
  const responder: ViewProps = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (e: GestureResponderEvent) => {
      drag.current.x0 = e.nativeEvent.pageX - e.nativeEvent.locationX
      drag.current.last = shown
      live(at(e.nativeEvent.pageX))
    },
    onResponderMove: (e: GestureResponderEvent) => live(at(e.nativeEvent.pageX)),
    onResponderRelease: done,
    onResponderTerminate: done,
  }
  const keys = (
    Platform.OS === 'web'
      ? {
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            const move = KEYS[e.key]
            if (!move) return
            e.preventDefault()
            jump(move(shown, step, min, max))
          },
        }
      : {}
  ) as ViewProps
  const said = format(shown)
  return (
    <View style={{ gap: SPACE[1] }}>
      <View aria-hidden style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', columnGap: SPACE[3], rowGap: TEXT_GAP }}>
        <Text variant="subhead" tone="text2">
          {label}
        </Text>
        <Text variant="headline" numbers>
          {said}
        </Text>
      </View>
      <View
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        aria-valuetext={said}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e: AccessibilityActionEvent) => jump(shown + (e.nativeEvent.actionName === 'increment' ? step : -step))}
        focusable
        onFocus={onFocus}
        onBlur={onBlur}
        onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))}
        {...responder}
        {...keys}
        style={[{ height: MIN_TARGET, justifyContent: 'center', borderRadius: THUMB / 2 }, WEB_TRACK, ring]}
      >
        <View style={{ marginHorizontal: THUMB / 2, height: TRACK, borderRadius: TRACK / 2, backgroundColor: colors.line, pointerEvents: 'none' }}>
          <View style={{ width: offset, height: TRACK, borderRadius: TRACK / 2, backgroundColor: colors.tabInd }} />
        </View>
        <View
          style={{
            position: 'absolute',
            left: offset,
            top: (MIN_TARGET - THUMB) / 2,
            width: THUMB,
            height: THUMB,
            borderRadius: THUMB / 2,
            backgroundColor: colors.surface,
            borderWidth: THUMB_EDGE,
            borderColor: colors.tabInd,
            pointerEvents: 'none',
          }}
        />
      </View>
      {note ? (
        <Text variant="footnote" tone="text2">
          {note}
        </Text>
      ) : null}
    </View>
  )
}

const frame = (run: () => void): number => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number))

function cancel(id: number | null) {
  if (id === null) return
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
  else clearTimeout(id)
}
