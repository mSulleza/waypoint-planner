import { View } from 'react-native'
import { Button } from './Button'
import { FieldError } from './TextField'
import { Text } from './Text'
import { useLocale, useTheme } from './theme'
import { LINE_WIDTH, RADII, SPACE } from './tokens'

export interface MonthStepperProps {
  // Shown above the control and read as its name.
  label: string
  // YYYY-MM.
  value: string
  onChange: (month: string) => void
  // The first and last months it steps to, YYYY-MM.
  min?: string
  max?: string
  // Under the control while there is no error.
  note?: string | null
  error?: string | null
  disabled?: boolean
}

const stepMonth = (month: string, by: number) => {
  const n = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by
  return `${String(Math.floor(n / 12)).padStart(4, '0')}-${String((n % 12) + 1).padStart(2, '0')}`
}

const monthName = (month: string, locale: string) => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))

// A month picked a step at a time, between the earlier and later buttons; the month reads out as it changes.
export function MonthStepper({ label, value, onChange, min, max, note, error, disabled = false }: MonthStepperProps) {
  const { colors } = useTheme()
  const locale = useLocale()
  const name = monthName(value, locale)
  return (
    <View role="group" aria-label={label} style={{ gap: SPACE[1] }}>
      <Text variant="subhead" tone="text2" style={{ fontWeight: '600' }}>
        {label}
      </Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: LINE_WIDTH,
          borderColor: error ? colors.negative : colors.controlBorder,
          borderRadius: RADII.control,
          backgroundColor: colors.surface,
          alignSelf: 'flex-start',
          maxWidth: '100%',
        }}
      >
        <Button label="Earlier month" icon="chevron-left" iconOnly variant="plain" disabled={disabled || (min !== undefined && value <= min)} onPress={() => onChange(stepMonth(value, -1))} />
        <Text aria-live="polite" variant="headline" numbers style={{ flexShrink: 1, minWidth: 160, textAlign: 'center', paddingHorizontal: SPACE[2] }}>
          {name}
        </Text>
        <Button label="Later month" icon="chevron-right" iconOnly variant="plain" disabled={disabled || (max !== undefined && value >= max)} onPress={() => onChange(stepMonth(value, 1))} />
      </View>
      {error ? (
        <FieldError text={error} />
      ) : note ? (
        <Text variant="footnote" tone="text2">
          {note}
        </Text>
      ) : null}
    </View>
  )
}
