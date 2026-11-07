import type { Ref } from 'react'
import { View } from 'react-native'
import { Choices } from './Choices'
import { TextField } from './TextField'
import { SPACE } from './tokens'
import type { DateFieldProps } from './DateField'

export type { DateFieldProps } from './DateField'

// Phones type the day; eight digits read as one, so the number pad can enter it.
export function DateField({ label, value, onChange, hint, note, error, editable = true, suggestions, ref }: DateFieldProps) {
  const picked = suggestions?.some((s) => s.day === value) ? value : null
  return (
    <View style={{ gap: SPACE[2] }}>
      <TextField
        ref={ref as Ref<never>}
        label={label}
        hint={hint ? `${hint} As YYYY-MM-DD.` : 'As YYYY-MM-DD.'}
        value={value}
        onChangeText={(text) => onChange(/^\d{8}$/.test(text.trim()) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text.trim())}
        inputMode="numeric"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={10}
        numbers
        error={error}
        note={note}
        editable={editable}
      />
      {suggestions && suggestions.length > 0 ? (
        <Choices layout="chips" label={`${label}, likely days`} groups={[{ choices: suggestions.map((s) => ({ value: s.day, title: s.label })) }]} value={picked} onChange={onChange} />
      ) : null}
    </View>
  )
}
