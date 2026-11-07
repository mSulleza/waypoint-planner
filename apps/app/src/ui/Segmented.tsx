import { useRef } from 'react'
import { Platform, Pressable, View, type PressableProps, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { Icon } from './icons'
import { Text } from './Text'
import { MIN_TARGET, useFocusRing, useTheme } from './theme'
import { LINE_WIDTH, PICKED, RADII, SEGMENT_INSET, SPACE } from './tokens'

export interface SegmentedProps<T extends string> {
  // A short label on the segment, and its whole name when the label is a short form.
  options: readonly { value: T; label: string; accessibilityLabel?: string }[]
  value: T
  onChange: (value: T) => void
  // Names the group for screen readers, e.g. 'Kind of entry'.
  label: string
}

const STEP: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowDown: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  ArrowUp: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_i, n) => n - 1,
}

// A radio group with one tab stop: arrow keys, Home and End move the choice and the focus together.
export function Segmented<T extends string>({ options, value, onChange, label }: SegmentedProps<T>) {
  const { colors } = useTheme()
  const refs = useRef<(View | null)[]>([])
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  const move = (key: string) => {
    const step = STEP[key]
    const next = step ? options[step(index, options.length)] : undefined
    if (!step || !next) return false
    onChange(next.value)
    refs.current[options.indexOf(next)]?.focus()
    return true
  }
  return (
    <View
      role="radiogroup"
      aria-label={label}
      // A white track; the picked segment stands out by its brand-text edge and check, not its brand-soft fill alone.
      style={{ flexDirection: 'row', padding: SEGMENT_INSET, gap: SEGMENT_INSET, borderRadius: RADII.control, backgroundColor: colors.surface, borderWidth: LINE_WIDTH, borderColor: colors.line }}
    >
      {options.map((o, i) => (
        <Segment key={o.value} label={o.label} name={o.accessibilityLabel} selected={i === index} onPress={() => onChange(o.value)} onKey={move} setRef={(r) => (refs.current[i] = r)} />
      ))}
    </View>
  )
}

interface SegmentProps {
  label: string
  name?: string
  selected: boolean
  onPress: () => void
  onKey: (key: string) => boolean
  setRef: (r: View | null) => void
}

function Segment({ label, name, selected, onPress, onKey, setRef }: SegmentProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const keys = Platform.OS === 'web' ? ({ onKeyDown: (e: { key: string; preventDefault: () => void }) => onKey(e.key) && e.preventDefault() } as Partial<PressableProps>) : {}
  const base: ViewStyle = {
    flex: 1,
    minHeight: MIN_TARGET,
    paddingHorizontal: SPACE[3],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE[1],
    borderRadius: RADII.control - SEGMENT_INSET,
    borderWidth: LINE_WIDTH,
    borderColor: selected ? colors[PICKED.edge] : 'transparent',
    backgroundColor: selected ? colors[PICKED.fill] : 'transparent',
  }
  const hover = ({ hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (hovered && !selected ? { backgroundColor: colors.surface2 } : null)
  return (
    <Pressable
      ref={setRef}
      role="radio"
      aria-label={name}
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onPress={onPress}
      onFocus={onFocus}
      onBlur={onBlur}
      {...keys}
      style={(s) => [base, hover(s), ring]}
    >
      {selected ? <Icon name="check" size={16} color={colors[PICKED.check]} strokeWidth={2.4} /> : null}
      <Text variant="subhead" tone={selected ? PICKED.label : 'text2'} style={{ flexShrink: 1, fontWeight: selected ? '600' : '400', textAlign: 'center' }}>
        {label}
      </Text>
    </Pressable>
  )
}
