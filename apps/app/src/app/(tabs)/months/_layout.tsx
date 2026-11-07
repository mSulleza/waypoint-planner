import { Stack } from 'expo-router'
import { useTheme } from '@/ui/theme'

// Each month or view change is a new entry here, so Back steps through them on the web and on phones.
export default function MonthsLayout() {
  const { colors } = useTheme()
  return <Stack screenOptions={{ headerShown: false, animation: 'none', contentStyle: { backgroundColor: colors.bg } }} />
}
