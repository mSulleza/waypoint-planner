import { createElement, useId, useState, type Ref } from 'react'
import { View } from 'react-native'
import { Choices } from './Choices'
import { Text } from './Text'
import { FieldError } from './TextField'
import { fontFor, MIN_TARGET, TYPE, useTheme } from './theme'
import { FOCUS_RING_WIDTH, LINE_WIDTH, RADII, SPACE } from './tokens'

export interface DateFieldProps {
  // Shown above the field and read as its name.
  label: string
  // YYYY-MM-DD, or '' for none.
  value: string
  onChange: (day: string) => void
  hint?: string
  // What the day reads as, such as its weekday, under the field while there is no error.
  note?: string | null
  error?: string | null
  // The first and last days the picker offers, YYYY-MM-DD.
  min?: string
  max?: string
  editable?: boolean
  // Likely days, one tap each, such as a card's last two cuts.
  suggestions?: readonly { day: string; label: string }[]
  ref?: Ref<{ focus: () => void }>
}

// A day picked with the browser's own date control, which shows it in the reader's date format and opens a calendar; never typed as an ISO string.
export function DateField({ label, value, onChange, hint, note, error, min, max, editable = true, suggestions, ref }: DateFieldProps) {
  const { colors, scheme } = useTheme()
  const ids = useId()
  const [ring, setRing] = useState(false)
  const describedBy = [hint ? `${ids}-hint` : null, error ? `${ids}-error` : note ? `${ids}-note` : null].filter(Boolean).join(' ') || undefined
  const picked = suggestions?.some((s) => s.day === value) ? value : null
  return (
    <View style={{ gap: SPACE[1] }}>
      <Text nativeID={`${ids}-label`} variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
        {label}
      </Text>
      {hint ? (
        <Text nativeID={`${ids}-hint`} variant="footnote" tone="text2">
          {hint}
        </Text>
      ) : null}
      {createElement('input', {
        ref,
        type: 'date',
        value,
        min,
        max,
        disabled: !editable,
        'aria-labelledby': `${ids}-label`,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        onChange: (e: { target: { value: string } }) => onChange(e.target.value),
        onFocus: (e: { target: Element }) => setRing(e.target.matches(':focus-visible')),
        onBlur: () => setRing(false),
        style: {
          boxSizing: 'border-box',
          width: '100%',
          minHeight: MIN_TARGET,
          margin: 0,
          padding: `0 ${SPACE[3]}px`,
          border: `${LINE_WIDTH}px solid ${error ? colors.negative : colors.controlBorder}`,
          borderRadius: RADII.control,
          backgroundColor: colors.surface,
          color: colors.text,
          colorScheme: scheme,
          ...fontFor(TYPE.body.fontWeight),
          fontSize: TYPE.body.fontSize,
          fontVariantNumeric: 'tabular-nums',
          opacity: editable ? 1 : 0.6,
          outline: ring ? `${FOCUS_RING_WIDTH}px solid ${error ? colors.negative : colors.focusRing}` : 'none',
          outlineOffset: FOCUS_RING_WIDTH,
        },
      })}
      {suggestions && suggestions.length > 0 ? (
        <Choices layout="chips" label={`${label}, likely days`} groups={[{ choices: suggestions.map((s) => ({ value: s.day, title: s.label })) }]} value={picked} onChange={onChange} />
      ) : null}
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
