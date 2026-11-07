import { Text as RNText, View } from 'react-native'
import { textStyle } from './Text'
import { useTheme } from './theme'
import { RADII, SPACE } from './tokens'

// A neutral tag beside a name, such as a plan item's Estimated: text-2 on surface-2, square-cornered so it never reads as a status pill.
export function Chip({ children }: { children: string }) {
  const { colors } = useTheme()
  return (
    <View style={{ paddingHorizontal: SPACE[2], paddingVertical: SPACE[1], borderRadius: RADII.chip, backgroundColor: colors.surface2 }}>
      <RNText style={textStyle('caption', colors.text2)}>{children}</RNText>
    </View>
  )
}
