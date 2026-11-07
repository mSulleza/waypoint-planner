import { Tabs } from 'expo-router/js-tabs'
import { Platform, useWindowDimensions } from 'react-native'
import { enableScreens } from 'react-native-screens'
import { SIDEBAR_MIN_WIDTH, TABS } from '@/shell/shell.model'
import { TabBar } from '@/ui/TabBar'
import { useTheme } from '@/ui/theme'

// Browsers get display: none on the tabs out of view, so Tab never lands on their hidden controls.
if (Platform.OS === 'web') enableScreens(true)

// Back retraces the tabs a person visited, as it does every other step whose state is in the URL.
export default function TabsLayout() {
  const { colors } = useTheme()
  const sidebar = useWindowDimensions().width >= SIDEBAR_MIN_WIDTH
  return (
    <Tabs
      backBehavior="history"
      tabBar={(props) => <TabBar {...props} sidebar={sidebar} />}
      screenOptions={{ headerShown: false, tabBarPosition: sidebar ? 'left' : 'bottom', sceneStyle: { backgroundColor: colors.bg } }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.title }} />
      ))}
    </Tabs>
  )
}
