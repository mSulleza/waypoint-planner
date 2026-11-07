import { Fragment, useRef } from 'react'
import { Platform, Pressable, View, type PressableProps, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { Card } from './Card'
import { Icon } from './icons'
import { Text } from './Text'
import { MIN_TARGET, useFocusRing, useTheme } from './theme'
import { GUTTER, LINE_WIDTH, PICKED, RADII, ROW_MIN_HEIGHT, SPACE, SWATCH, UNPICKED } from './tokens'

export interface Choice<T extends string> {
  value: T
  title: string
  // Under the title in a row; above it, smaller, in a chip.
  detail?: string
  // What a screen reader says, when the title and detail are short forms.
  label?: string
  // An account's identity colour: a chip shows its 10 pt swatch before the name.
  colour?: string
}

export interface ChoicesProps<T extends string> {
  // Names the group for screen readers.
  label: string
  // Rows in cards under optional headings, or short chips that wrap.
  groups: readonly { title?: string; choices: readonly Choice<T>[] }[]
  value: T | null
  onChange: (value: T) => void
  // A tap or Enter on a choice, after onChange; arrow keys only move the choice, so a picker can close on this alone.
  onPress?: (value: T) => void
  layout?: 'rows' | 'chips'
}

const STEP: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowDown: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  ArrowUp: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_i, n) => n - 1,
}

// One radio group with one tab stop, like Segmented, for choices too many or too long for a segmented control.
export function Choices<T extends string>({ label, groups, value, onChange, onPress, layout = 'rows' }: ChoicesProps<T>) {
  const refs = useRef<(View | null)[]>([])
  const all = groups.flatMap((g) => g.choices)
  const index = all.findIndex((c) => c.value === value)
  // With nothing picked yet, the first choice takes the tab stop.
  const stop = Math.max(0, index)
  const move = (key: string) => {
    const step = STEP[key]
    const next = step ? all[step(stop, all.length)] : undefined
    if (!step || !next) return false
    onChange(next.value)
    refs.current[all.indexOf(next)]?.focus()
    return true
  }
  let k = 0
  return (
    <View role="radiogroup" aria-label={label} style={{ gap: layout === 'chips' ? 0 : SPACE[4] }}>
      {groups.map((g, gi) => {
        const items = g.choices.map((c) => {
          const i = k++
          const props = {
            choice: c,
            selected: c.value === value,
            tabbable: i === stop,
            onPress: () => {
              onChange(c.value)
              onPress?.(c.value)
            },
            onKey: move,
            setRef: (r: View | null) => (refs.current[i] = r),
          }
          return layout === 'chips' ? <Chip key={c.value} {...props} /> : <ChoiceRow key={c.value} {...props} divider={g.choices.indexOf(c) > 0} />
        })
        return (
          <Fragment key={g.title ?? gi}>
            {layout === 'chips' ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE[2] }}>{items}</View>
            ) : (
              <View style={{ gap: SPACE[2] }}>
                {g.title ? (
                  <Text variant="footnote" tone="text2" style={{ fontWeight: '600' }}>
                    {g.title}
                  </Text>
                ) : null}
                <Card flush>{items}</Card>
              </View>
            )}
          </Fragment>
        )
      })}
    </View>
  )
}

interface ItemProps<T extends string> {
  choice: Choice<T>
  selected: boolean
  tabbable: boolean
  onPress: () => void
  onKey: (key: string) => boolean
  setRef: (r: View | null) => void
}

function useItem({ onKey }: { onKey: (key: string) => boolean }) {
  const { ring, onFocus, onBlur } = useFocusRing()
  const keys = Platform.OS === 'web' ? ({ onKeyDown: (e: { key: string; preventDefault: () => void }) => onKey(e.key) && e.preventDefault() } as Partial<PressableProps>) : {}
  return { ring, handlers: { onFocus, onBlur, ...keys } }
}

function ChoiceRow<T extends string>({ choice, selected, tabbable, onPress, onKey, setRef, divider }: ItemProps<T> & { divider: boolean }) {
  const { colors } = useTheme()
  const { ring, handlers } = useItem({ onKey })
  const base: ViewStyle = { minHeight: Math.max(ROW_MIN_HEIGHT, MIN_TARGET), flexDirection: 'row', alignItems: 'center', gap: SPACE[3], paddingHorizontal: GUTTER, paddingVertical: SPACE[3] }
  const hover = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { backgroundColor: colors.surface2 } : null)
  return (
    <Pressable ref={setRef} role="radio" aria-checked={selected} aria-label={choice.label} tabIndex={tabbable ? 0 : -1} onPress={onPress} {...handlers} style={(s) => [base, hover(s), ring && { ...ring, outlineOffset: -2 }]}>
      {divider ? <View style={{ position: 'absolute', top: 0, left: GUTTER, right: 0, height: LINE_WIDTH, backgroundColor: colors.line }} /> : null}
      <Dot selected={selected} />
      <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
        <Text style={{ fontWeight: selected ? '600' : '400' }}>{choice.title}</Text>
        {choice.detail ? (
          <Text variant="footnote" tone="text2">
            {choice.detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

// The radio mark: an outlined ring, filled at its centre when chosen.
function Dot({ selected }: { selected: boolean }) {
  const { colors } = useTheme()
  return (
    <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: selected ? colors.brandText : colors.controlBorder, alignItems: 'center', justifyContent: 'center' }}>
      {selected ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brandText }} /> : null}
    </View>
  )
}

function Chip<T extends string>({ choice, selected, tabbable, onPress, onKey, setRef }: ItemProps<T>) {
  const { colors } = useTheme()
  const { ring, handlers } = useItem({ onKey })
  const base: ViewStyle = {
    minHeight: MIN_TARGET,
    minWidth: choice.detail ? 64 : MIN_TARGET,
    paddingHorizontal: SPACE[3],
    paddingVertical: choice.detail ? SPACE[2] : 0,
    borderRadius: RADII.control,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE[1],
    borderWidth: LINE_WIDTH,
    borderColor: colors[selected ? PICKED.edge : UNPICKED.edge],
    backgroundColor: colors[selected ? PICKED.fill : UNPICKED.fill],
  }
  const hover = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (!selected && (pressed || hovered) ? { backgroundColor: colors.surface2 } : null)
  return (
    <Pressable ref={setRef} role="radio" aria-checked={selected} aria-label={choice.label} tabIndex={tabbable ? 0 : -1} onPress={onPress} {...handlers} style={(s) => [base, hover(s), ring]}>
      {selected ? <Icon name="check" size={16} color={colors[PICKED.check]} strokeWidth={2.4} /> : null}
      {choice.colour ? <View style={{ width: SWATCH.size, height: SWATCH.size, borderRadius: SWATCH.radius, marginRight: SPACE[1], backgroundColor: choice.colour }} /> : null}
      <View style={{ alignItems: 'center' }}>
        {choice.detail ? (
          <Text variant="caption" tone="text2">
            {choice.detail}
          </Text>
        ) : null}
        <Text variant={choice.detail ? 'headline' : 'subhead'} tone={selected ? PICKED.label : UNPICKED.label} numbers style={{ fontWeight: selected || choice.detail ? '600' : '400' }}>
          {choice.title}
        </Text>
      </View>
    </Pressable>
  )
}
