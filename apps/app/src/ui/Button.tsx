import type { Ref } from 'react'
import { Pressable, View, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { Icon, type IconName } from './icons'
import { Text } from './Text'
import { MIN_TARGET, useFocusRing, useTheme } from './theme'
import { LINE_WIDTH, RADII, SPACE } from './tokens'

export interface ButtonProps {
  label: string
  onPress: () => void
  // Tonal is brand-text on brand-soft, for every action but the one the screen leads with (spec §8); secondary is white with a brand-text label on a status fill, as the hero's is on Cobalt; icon is an ink glyph for the header's tools.
  variant?: 'primary' | 'tonal' | 'secondary' | 'plain' | 'icon'
  // A small button narrows its padding, never its height.
  size?: 'default' | 'small'
  icon?: IconName
  // Shows only the icon; the label becomes its accessible name.
  iconOnly?: boolean
  // A circle, as the header's + is.
  round?: boolean
  disabled?: boolean
  // A fuller name for screen readers when many buttons share a label, such as 'Record Rent'; it starts with the label.
  accessibilityLabel?: string
  // A disclosure button: whether the part it shows is open.
  expanded?: boolean
  ref?: Ref<View>
}

export function Button({ label, onPress, variant = 'tonal', size = 'default', icon, iconOnly = false, round = false, disabled = false, accessibilityLabel, expanded, ref }: ButtonProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  // A primary button is a Cobalt fill on a card or sheet, so tab-ind, which holds 3:1 there in dark; the round + sits on the page in brand.
  const [solid, onSolid] = round ? [colors.brand, colors.onBrand] : [colors.tabInd, colors.onTabInd]
  // Disabled reads in text-3, never faded, so its words stay legible (4.5:1).
  const fg = disabled ? colors.text3 : variant === 'primary' ? onSolid : variant === 'icon' ? colors.text : colors.brandText
  const fill = variant === 'primary' ? solid : variant === 'tonal' ? colors.brandSoft : variant === 'secondary' ? colors.surface : 'transparent'
  // A filled button that does nothing drops its fill for an outline, so it never passes for a tonal one beside it.
  const filled = variant === 'primary' || variant === 'tonal' || variant === 'secondary'
  const outlined = disabled && filled
  const base: ViewStyle = {
    minHeight: MIN_TARGET,
    minWidth: MIN_TARGET,
    paddingHorizontal: iconOnly ? 0 : size === 'small' ? SPACE[3] : SPACE[5],
    borderRadius: round ? RADII.pill : RADII.control,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE[2],
    backgroundColor: outlined ? 'transparent' : fill,
    borderWidth: outlined ? LINE_WIDTH : 0,
    borderColor: colors.line,
  }
  const state = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => {
    if (disabled || !(pressed || hovered)) return null
    if (variant === 'primary' || variant === 'tonal' || variant === 'secondary') return { opacity: pressed ? 0.8 : 0.9 }
    return { backgroundColor: variant === 'plain' || variant === 'icon' ? colors.brandSoft : colors.surface2 }
  }
  return (
    <Pressable
      ref={ref}
      role="button"
      aria-label={iconOnly ? label : accessibilityLabel}
      aria-disabled={disabled}
      aria-expanded={expanded}
      disabled={disabled}
      onPress={onPress}
      onFocus={onFocus}
      onBlur={onBlur}
      style={(s) => [base, state(s), ring]}
    >
      {icon ? <Icon name={icon} size={20} color={fg} /> : null}
      {iconOnly ? null : (
        <Text variant={size === 'small' ? 'subhead' : 'body'} style={{ color: fg, fontWeight: '600', textAlign: 'center' }}>
          {label}
        </Text>
      )}
    </Pressable>
  )
}
