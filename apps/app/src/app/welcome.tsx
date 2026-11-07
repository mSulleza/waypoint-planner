import { SAMPLE_LIST } from '@waypoint/core/fixtures/sample-list'
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CODE_LENGTH } from '@/data/auth'
import { SESSION_ENDED } from '@/data/errors'
import { useDataSource } from '@/data/source'
import { PageTitle } from '@/shell/Screen'
import { Section, SignIn } from '@/shell/SignIn'
import { useAddressBar } from '@/shell/useAddressBar'
import { Banner } from '@/ui/Banner'
import { Card } from '@/ui/Card'
import { Row } from '@/ui/Row'
import { Text } from '@/ui/Text'
import { useTheme } from '@/ui/theme'
import { GUTTER, SPACE } from '@/ui/tokens'

// One narrow column at every width: a form reads best at about 60 characters.
const COLUMN = 480

const ACCOUNT_DELETED = 'Your sign-in, your household and everything in it are gone from Waypoint.'

// The way in: try a read-only sample, or sign in with a code sent by email (a password only for reviewers).
export default function Welcome() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { source, openSample, ended, deleted } = useDataSource()
  const [opening, setOpening] = useState<string | null>(null)
  useAddressBar()

  // The tabs open with the sample, so the link to them waits until it is open.
  useEffect(() => {
    if (opening === null || source.kind !== 'sample' || source.id !== opening) return
    setOpening(null)
    router.push({ pathname: '/', params: { sample: opening } })
  }, [opening, source, router])

  const pick = (id: string) => {
    openSample(id)
    setOpening(id)
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageTitle title="Welcome" />
      <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={{ paddingTop: insets.top + SPACE[12], paddingBottom: insets.bottom + SPACE[12], paddingHorizontal: GUTTER }}>
        <View role="main" style={{ width: '100%', maxWidth: COLUMN, alignSelf: 'center', gap: SPACE[8] }}>
          <View style={{ gap: SPACE[2] }}>
            <Text variant="display" level={1}>
              Waypoint
            </Text>
            <Text tone="text2">Pay down debt and keep enough cash in each account, even when your money is in more than one currency.</Text>
          </View>
          {deleted ? <Banner tone="positive" title="Account deleted" body={ACCOUNT_DELETED} /> : ended ? <Banner tone="neutral" title="Signed out" body={SESSION_ENDED} /> : null}
          <Section title="Try a sample" note="A made-up household to look around in. No account needed, and nothing is saved.">
            <Card flush>
              {SAMPLE_LIST.map((s, i) => (
                <Row key={s.id} divider={i > 0} title={s.title} onPress={() => pick(s.id)} />
              ))}
            </Card>
          </Section>
          <SignIn title="Sign in" note={`Enter your email and we will send a ${CODE_LENGTH}\u2011digit code. A new address gets a new account.`} create />
        </View>
      </ScrollView>
    </View>
  )
}
