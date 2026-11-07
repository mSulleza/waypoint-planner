import { useId } from 'react'
import { Pressable, View, type PressableStateCallbackType, type ViewStyle } from 'react-native'
import { Icon } from './icons'
import { Text } from './Text'
import { FieldError } from './TextField'
import { MIN_TARGET, useFocusRing, useTheme } from './theme'
import { LINE_WIDTH, RADII, SPACE } from './tokens'

export interface SelectFieldProps {
  // Shown above the field and read as its name.
  label: string
  // The choice made, or null while there is none.
  value: string | null
  // Shown in the field while nothing is chosen.
  placeholder: string
  // What the choice sets, under the label.
  hint?: string
  // What the choice reads as, under the field while there is no error.
  note?: string | null
  // A second line in the field, such as an example of the choice.
  detail?: string | null
  // What is wrong, under the field with an icon.
  error?: string | null
  // Opens the picker, usually a sheet of Choices.
  onPress: () => void
}

// A field whose value comes from a list too long for a segmented control; it looks like a text field and opens a picker.
export function SelectField({ label, value, placeholder, hint, note, detail, error, onPress }: SelectFieldProps) {
  const { colors } = useTheme()
  const { ring, onFocus, onBlur } = useFocusRing()
  const hover = ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }): ViewStyle | null => (pressed || hovered ? { backgroundColor: colors.surface2 } : null)
  const ids = useId()
  // Read after the field's name, as TextField ties its own.
  const describedBy = [hint ? `${ids}-hint` : null, error ? `${ids}-error` : note ? `${ids}-note` : null].filter(Boolean).join(' ') || undefined
  return (
    <View style={{ gap: SPACE[1] }}>
      <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
        {label}
      </Text>
      {hint ? (
        <Text nativeID={`${ids}-hint`} variant="footnote" tone="text2">
          {hint}
        </Text>
      ) : null}
      <Pressable
        role="button"
        aria-label={`${label}: ${value ?? placeholder}`}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        onPress={onPress}
        onFocus={onFocus}
        onBlur={onBlur}
        style={(s) => [
          {
            minHeight: MIN_TARGET,
            flexDirection: 'row',
            alignItems: 'center',
            gap: SPACE[2],
            paddingHorizontal: SPACE[3],
            paddingVertical: SPACE[2],
            borderRadius: RADII.control,
            borderWidth: LINE_WIDTH,
            borderColor: error ? colors.negative : colors.controlBorder,
            backgroundColor: colors.surface,
          },
          hover(s),
          ring,
        ]}
      >
        <View style={{ flex: 1, minWidth: 0, gap: SPACE[1] }}>
          <Text tone={value === null ? 'text3' : 'text'}>{value ?? placeholder}</Text>
          {detail ? (
            <Text variant="footnote" tone="text2" numberOfLines={1}>
              {detail}
            </Text>
          ) : null}
        </View>
        <Icon name="chevron-down" size={18} color={colors.text2} />
      </Pressable>
      {error ? (
        <FieldError id={`${ids}-error`} text={error} />
      ) : note ? (
        <Text nativeID={`${ids}-note`} variant="footnote" tone="text2">
          {note}
        </Text>
      ) : null}
    </View>
  )
}
