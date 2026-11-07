import { View, type ViewProps } from 'react-native'
import { useTheme } from './theme'
import { CARD_PADDING, LINE_WIDTH, RADII, SPACE } from './tokens'

export interface CardProps extends ViewProps {
  // Flush cards hold rows, which carry their own padding.
  flush?: boolean
}

// Flat: a 1 px line and no shadow; only sheets cast one.
export function Card({ flush = false, style, ...rest }: CardProps) {
  const { colors } = useTheme()
  return (
    <View
      {...rest}
      style={[
        { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: LINE_WIDTH, borderRadius: RADII.card, overflow: 'hidden' },
        flush ? null : { padding: CARD_PADDING, gap: SPACE[3] },
        style,
      ]}
    />
  )
}
