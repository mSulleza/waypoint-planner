import { View } from 'react-native'
import { Button } from './Button'
import { Text } from './Text'
import { SPACE } from './tokens'

export interface EmptyStateProps {
  // Why it is empty.
  title: string
  // What fills it.
  body: string
  // The one way to fill it.
  action: { label: string; onPress: () => void }
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: SPACE[8], paddingHorizontal: SPACE[4], gap: SPACE[2] }}>
      <Text variant="headline" style={{ textAlign: 'center' }}>
        {title}
      </Text>
      <Text tone="text2" style={{ textAlign: 'center', maxWidth: 360 }}>
        {body}
      </Text>
      <View style={{ marginTop: SPACE[3] }}>
        <Button label={action.label} onPress={action.onPress} variant="primary" />
      </View>
    </View>
  )
}
