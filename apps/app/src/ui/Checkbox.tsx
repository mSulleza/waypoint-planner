import { Platform, Pressable, View, type PressableProps, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { Icon } from './icons'
import { Text } from './Text'
import { MIN_TARGET, useFocusRing, useTheme } from './theme'
import { LINE_WIDTH, PICKED, RADII, SPACE, UNPICKED } from './tokens'

export interface CheckboxProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  // A second line under the label in a row; a chip has none.
  detail?: string
  // A row with the box before the label, a chip that shows a tick when on, or the box alone in a list row, the label read by screen readers only.
  variant?: 'row' | 'chip' | 'box'
  disabled?: boolean
}

const BOX = 20

// One on-off choice. Space toggles it on the web as Enter does, as a native checkbox would.
export function Checkbox({ label, checked, onChange, detail, variant = 'row', disabled = false }: CheckboxProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const toggle = () => onChange(!checked)
  const keys =
    Platform.OS === 'web'
      ? ({
          onKeyDown: (e: { key: string; preventDefault: () => void }) => {
            if (e.key !== ' ' || disabled) return
            e.preventDefault()
            toggle()
          },
        } as Partial<PressableProps>)
      : {}
  const chip = variant === 'chip'
  const alone = variant === 'box'
  const base: ViewStyle = alone
    ? { width: MIN_TARGET, height: MIN_TARGET, alignItems: 'center', justifyContent: 'center', borderRadius: RADII.chip }
    : chip
    ? {
        minHeight: MIN_TARGET,
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: SPACE[2],
        paddingHorizontal: SPACE[3],
        borderRadius: RADII.control,
        borderWidth: LINE_WIDTH,
        borderColor: disabled ? colors.line : colors[checked ? PICKED.edge : UNPICKED.edge],
        backgroundColor: disabled ? 'transparent' : colors[checked ? PICKED.fill : UNPICKED.fill],
      }
    : { minHeight: MIN_TARGET, flexDirection: 'row', alignItems: detail ? 'flex-start' : 'center', gap: SPACE[3], paddingVertical: SPACE[2], borderRadius: RADII.chip }
  // Disabled reads in text-3 with quiet lines, never faded, so its words stay legible.
  const mark = disabled ? colors.text3 : colors.tabInd
  const hover = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (!disabled && (pressed || hovered) && (chip ? !checked : true) ? { backgroundColor: chip || alone ? colors.surface2 : undefined } : null)
  return (
    <Pressable role="checkbox" aria-checked={checked} aria-label={label} aria-disabled={disabled} disabled={disabled} onPress={toggle} onFocus={onFocus} onBlur={onBlur} {...keys} style={(s) => [base, hover(s), ring]}>
      {chip ? (
        checked ? (
          <Icon name="check" size={16} color={disabled ? colors.text3 : colors[PICKED.check]} strokeWidth={2.4} />
        ) : null
      ) : (
        <View
          style={{
            width: BOX,
            height: BOX,
            marginTop: detail && !alone ? 2 : 0,
            borderRadius: 6,
            borderWidth: 2,
            borderColor: disabled ? (checked ? mark : colors.line) : checked ? colors.tabInd : colors.controlBorder,
            backgroundColor: checked ? mark : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {checked ? <Icon name="check" size={14} color={colors.onTabInd} /> : null}
        </View>
      )}
      {alone ? null : (
        <View style={{ flexShrink: 1, gap: SPACE[1] }}>
          <Text variant={chip ? 'subhead' : 'body'} tone={disabled ? 'text3' : 'text'} style={{ fontWeight: chip && checked ? '600' : '400' }}>
            {label}
          </Text>
          {detail && !chip ? (
            <Text variant="footnote" tone="text2">
              {detail}
            </Text>
          ) : null}
        </View>
      )}
    </Pressable>
  )
}
