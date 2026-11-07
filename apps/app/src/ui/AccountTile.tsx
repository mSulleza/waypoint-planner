import { Platform, Text as RNText, View, type ViewProps } from 'react-native'
import { tileLetters } from './identity'
import { fontFor, useTheme } from './theme'
import { identityColor, RADII, TILE } from './tokens'

export interface AccountTileProps {
  name: string
  // The account's place in the account order (identityIndex), which picks its colour.
  colour: number
  size?: keyof typeof TILE
}

// Hidden from screen readers: the name beside it says which account it is.
const HIDDEN = (Platform.OS === 'web' ? { 'aria-hidden': true } : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }) as ViewProps

// An account's square lettered tile in its identity colour, the same on every screen; never a status.
export function AccountTile({ name, colour, size = 'row' }: AccountTileProps) {
  const { colors, scheme } = useTheme()
  const side = TILE[size]
  return (
    <View {...HIDDEN} style={{ width: side, height: side, borderRadius: RADII.tile, alignItems: 'center', justifyContent: 'center', flexShrink: 0, backgroundColor: identityColor(colour, scheme) }}>
      {/* The name beside it follows the text size; the letters keep to the tile. */}
      <RNText maxFontSizeMultiplier={1} numberOfLines={1} style={{ ...fontFor('700'), fontSize: size === 'row' ? 13 : 14, lineHeight: 16, letterSpacing: 0.26, color: colors.onId }}>
        {tileLetters(name)}
      </RNText>
    </View>
  )
}
