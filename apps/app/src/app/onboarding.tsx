import { useRouter } from 'expo-router'
import { Suspense, useState } from 'react'
import { View } from 'react-native'
import type { DataError } from '@/data/errors'
import { signOut } from '@/data/signout'
import { loadFlow } from '@/screens/onboarding/load'
import { lazyPart } from '@/shell/lazyPart'
import { NotLoaded } from '@/shell/NotLoaded'
import { Screen } from '@/shell/Screen'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Text } from '@/ui/Text'
import { SPACE } from '@/ui/tokens'

// A form reads best at about 60 characters, so the questions keep a narrow column under the title.
const COLUMN = 560

// Most visits never need this code (the web's 500 kB first-load budget).
const useFlow = lazyPart<{ step: number; setStep: (step: number) => void }>(
  () => loadFlow().then((m) => m.Flow),
  ({ retry }) => <NotLoaded what="Set-up" retry={retry} />,
)

// Only an account with no household reaches this; the gate closes it once the household exists, which opens Today.
export default function Onboarding() {
  const [step, setStep] = useState(0)
  const Flow = useFlow()
  return (
    <Screen title="Set up" kind="flow" phases={['no_household']} hideNotices={['no_household']} scrollKey={step}>
      <View style={{ width: '100%', maxWidth: COLUMN, gap: SPACE[8] }}>
        <Suspense fallback={<Text tone="text2">Loading…</Text>}>
          <Flow step={step} setStep={setStep} />
        </Suspense>
        <SignOut />
      </View>
    </Screen>
  )
}

// The tabs and Settings are closed until set-up is done, so leaving, and deleting the account (Apple 5.1.1(v)), are offered here.
function SignOut() {
  const router = useRouter()
  const [problem, setProblem] = useState<DataError | null>(null)
  return (
    <View style={{ gap: SPACE[2] }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -SPACE[3] }}>
        <Button label="Sign out" variant="plain" size="small" onPress={() => void signOut().then(setProblem)} />
        <Button label="Delete account" variant="plain" size="small" onPress={() => router.push('/delete-account')} />
      </View>
      {problem ? <Banner tone="negative" title="Not signed out" body={problem.message} detail={problem.technical ?? undefined} /> : null}
    </View>
  )
}
