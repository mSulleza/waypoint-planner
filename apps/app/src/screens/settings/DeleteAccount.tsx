import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { CODE_LENGTH } from '@/data/auth'
import { deleteAccount } from '@/data/delete-account'
import { ERROR_TITLES, type DataError } from '@/data/errors'
import { useSnapshot } from '@/data/hooks'
import { signOut } from '@/data/signout'
import { useDataSource } from '@/data/source'
import { getSupabase, storedEmail } from '@/data/supabase'
import { Section, SignIn } from '@/shell/SignIn'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Row } from '@/ui/Row'
import { Text } from '@/ui/Text'
import { TextField } from '@/ui/TextField'
import { SPACE } from '@/ui/tokens'
import { CONFIRM_WORD, confirmed, EVERYTHING, householdWords } from './delete.model'
import { exportDetail, useExport } from './useExport'

type Stage = 'idle' | 'deleting' | 'deleted'

// Spec §10: Settings > Delete account and the public page share this flow. Signed out, it signs in with an emailed code first (Google Play needs a web path); signed in, it says what goes, asks for DELETE and calls delete_my_account.
export function DeleteAccountBody() {
  const { owner } = useDataSource()
  const router = useRouter()
  // Lifted here, so the sign-out that ends the flow does not draw the sign-in form before Welcome opens.
  const [stage, setStage] = useState<Stage>('idle')
  useEffect(() => {
    // Welcome opens only once the gate has seen the sign-out, so the move waits for it.
    if (stage === 'deleted' && owner === null) router.replace('/welcome')
  }, [stage, owner, router])
  if (stage === 'deleted') return <Banner tone="positive" title="Account deleted" body="Opening Welcome…" />
  return (
    <View style={{ gap: SPACE[10] }}>
      <Text tone="text2">{owner === null && stage === 'idle' ? `Sign in with a code sent to your email, type ${CONFIRM_WORD}, then press Delete account. It cannot be undone.` : 'Deleting the account removes it from Waypoint at once. It cannot be undone.'}</Text>
      <WhatGoes signedIn={owner !== null} />
      {owner === null && stage === 'idle' ? (
        <SignIn title="Sign in" note={`Enter the email of the account to delete, and we will send a ${CODE_LENGTH}‑digit code.`} create={false} />
      ) : (
        <Confirm busy={stage === 'deleting'} onStage={setStage} />
      )}
    </View>
  )
}

function WhatGoes({ signedIn }: { signedIn: boolean }) {
  const { source, snapshot, phase } = useSnapshot()
  // A sample open over the account says nothing about the account's own household.
  const own = source.kind === 'supabase'
  const email = signedIn ? storedEmail() : null
  const none = own && phase === 'no_household'
  const household = none ? 'None yet' : own && snapshot ? householdWords(snapshot.doc) : EVERYTHING
  // Signed in with a household, the copy is made right here; signed out, it is offered once the code is in.
  const canExport = signedIn && own && snapshot !== null
  const exported = useExport()
  const failed = exported.state.kind === 'failed' ? exported.state.error : null
  return (
    <Section title="What is deleted" note={none ? 'This account has no household, so only its sign-in goes.' : canExport ? 'To keep a copy, export your data first.' : signedIn ? 'To keep a copy, use Export data in Settings first.' : 'Once you are signed in, you can export a copy here first.'}>
      <Card flush>
        <Row title="Your sign-in" detail={email ?? 'The email address and its codes'} />
        <Row divider title="Your household" detail={household} />
        {canExport ? <Row divider title="Export data" detail={exportDetail(exported.state)} onPress={exported.run} /> : null}
      </Card>
      {failed ? <Banner tone="negative" title={failed.kind === 'network' ? ERROR_TITLES.network : 'Not exported'} body={failed.message} detail={failed.technical ?? undefined} /> : null}
    </Section>
  )
}

function Confirm({ busy, onStage }: { busy: boolean; onStage: (stage: Stage) => void }) {
  const [typed, setTyped] = useState('')
  const [problem, setProblem] = useState<DataError | null>(null)
  const ready = confirmed(typed)
  // A ref, not state: Return and a tap in the same moment must not both reach the server.
  const inFlight = useRef(false)
  const run = async () => {
    if (!ready || inFlight.current) return
    inFlight.current = true
    onStage('deleting')
    setProblem(null)
    const failed = await deleteAccount({ rpc: (fn, args) => getSupabase().rpc(fn, args), signOut: () => signOut(undefined, 'deleted') })
    inFlight.current = false
    if (failed) setProblem(failed)
    onStage(failed ? 'idle' : 'deleted')
  }
  return (
    <Section title="Delete the account" note={`Type ${CONFIRM_WORD} in capital letters to turn on the button.`}>
      <Card>
        <TextField
          label={`Type ${CONFIRM_WORD}`}
          value={typed}
          onChangeText={(text) => {
            setTyped(text)
            setProblem(null)
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          enterKeyHint="done"
          onSubmitEditing={() => void run()}
          editable={!busy}
        />
        {problem ? <Banner tone="negative" title={problem.kind === 'network' ? ERROR_TITLES.network : 'Not deleted'} body={problem.message} detail={problem.technical ?? undefined} /> : null}
        <View style={{ flexDirection: 'row' }}>
          <Button label={busy ? 'Deleting…' : 'Delete account'} variant="primary" onPress={() => void run()} disabled={!ready || busy} />
        </View>
      </Card>
    </Section>
  )
}
