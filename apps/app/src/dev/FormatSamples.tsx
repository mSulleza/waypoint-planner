import { ScrollView } from 'react-native'
import { intlSamples } from '@/dev/intl-samples'
import { Text } from '@/ui/Text'

export default function FormatSamples() {
  const s = intlSamples()
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 4 }}>
      <Text selectable variant="footnote" numbers>
        device zone: {s.deviceTimeZone}
      </Text>
      <Text selectable variant="footnote" numbers>
        Manila: {s.manila}
      </Text>
      <Text selectable variant="footnote" numbers>
        Madrid: {s.madrid}
      </Text>
      {s.money.map((m) => (
        <Text selectable variant="footnote" numbers key={`${m.locale}-${m.currency}`}>
          {m.locale} {m.currency} {m.maxFractionDigits} | {m.formatted} | {m.compact}
        </Text>
      ))}
    </ScrollView>
  )
}
