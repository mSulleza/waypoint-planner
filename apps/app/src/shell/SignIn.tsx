import { useRef, useState, type ReactNode } from 'react'
import { View, type TextInput } from 'react-native'
import { codeDigits, CODE_LENGTH, looksLikeEmail, sendCode, sendCodeToAccount, signInWithPassword, verifyCode } from '@/data/auth'
import type { DataError } from '@/data/errors'
import { useDataSource } from '@/data/source'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Text } from '@/ui/Text'
import { TextField } from '@/ui/TextField'
import { SPACE } from '@/ui/tokens'

// Plain buttons whose text lines up with the fields; their 44 pt targets reach into the card's padding.
const LINKS = { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -SPACE[3], marginBottom: -SPACE[2] } as const

// Each step passes its own key, so its fields mount fresh and autoFocus applies.
export function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <View style={{ gap: SPACE[3] }}>
      <View style={{ gap: SPACE[1] }}>
        <Text variant="title2" level={2}>
          {title}
        </Text>
        <Text variant="subhead" tone="text2">
          {note}
        </Text>
      </View>
      {children}
    </View>
  )
}

type Step = { kind: 'email' } | { kind: 'code'; email: string } | { kind: 'password' }

export interface SignInProps {
  // The email step's heading and the line under it.
  title: string
  note: string
  // Welcome makes an account for a new address; the delete page sends a code only to one that has an account.
  create: boolean
}

// Sign-in by a code sent by email, with a password for the accounts given one (store reviewers').
export function SignIn({ title, note, create }: SignInProps) {
  const { source, exitSample } = useDataSource()
  const [step, setStep] = useState<Step>({ kind: 'email' })
  // Focus moves to the new field only after a step the person took, never on arrival.
  const [moved, setMoved] = useState(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ title: string; error: DataError } | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [resent, setResent] = useState(false)
  const passwordField = useRef<TextInput>(null)
  const codeField = useRef<TextInput>(null)
  const sender = create ? sendCode : sendCodeToAccount

  const go = (next: Step) => {
    setStep(next)
    setMoved(true)
    setProblem(null)
    setFieldError(null)
    setResent(false)
    setCode('')
    setPassword('')
  }

  // A ref, not state: an autofilled code and Enter in the same moment must not both reach the server.
  const inFlight = useRef(false)
  const attempt = async (title: string, job: () => Promise<DataError | null>): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    setProblem(null)
    setResent(false)
    try {
      const failed = await job()
      setProblem(failed ? { title, error: failed } : null)
      return failed === null
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const checkEmail = (): boolean => {
    const ok = looksLikeEmail(email)
    setFieldError(ok ? null : 'Enter a whole email address, like name@example.com.')
    return ok
  }

  const send = async () => {
    if (!checkEmail()) return
    if (await attempt('Code not sent', () => sender(email))) go({ kind: 'code', email: email.trim() })
  }

  const resend = async (to: string) => {
    if (!(await attempt('Code not sent', () => sender(to)))) return
    setResent(true)
    codeField.current?.focus()
  }

  // Signing in is choosing your own household, so an open sample closes first.
  const leaveSample = () => {
    if (source.kind === 'sample') exitSample()
  }

  const verify = async (to: string, digits: string) => {
    if (inFlight.current || digits.length !== CODE_LENGTH) return
    leaveSample()
    if (!(await attempt('Not signed in', () => verifyCode(to, digits)))) setCode('')
  }

  const typeCode = (to: string, text: string) => {
    const digits = codeDigits(text)
    setCode(digits)
    // A pasted or autofilled code signs in without another tap.
    if (digits.length === CODE_LENGTH) void verify(to, digits)
  }

  const withPassword = async () => {
    if (!checkEmail() || password === '') return
    leaveSample()
    await attempt('Not signed in', () => signInWithPassword(email, password))
  }

  const banner = problem ? <Banner tone="negative" title={problem.title} body={problem.error.message} detail={problem.error.technical ?? undefined} /> : null

  if (step.kind === 'code') {
    return (
      <Section key="code" title="Enter the code" note={`We sent a ${CODE_LENGTH}\u2011digit code to ${step.email}. It works once, within the hour.`}>
        <Card>
          <TextField
            ref={codeField}
            label="Code"
            value={code}
            onChangeText={(t) => typeCode(step.email, t)}
            code
            inputMode="numeric"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            autoFocus={moved}
            enterKeyHint="done"
            onSubmitEditing={() => void verify(step.email, code)}
            editable={!busy}
          />
          {banner}
          {resent ? <Banner tone="positive" title="New code sent" body="Use the code in the newest email." /> : null}
          <Button label={busy ? 'Signing in…' : 'Sign in'} variant="primary" onPress={() => void verify(step.email, code)} disabled={busy || code.length !== CODE_LENGTH} />
          <View style={LINKS}>
            <Button label="Send a new code" variant="plain" size="small" onPress={() => void resend(step.email)} disabled={busy} />
            <Button label="Use another email" variant="plain" size="small" onPress={() => go({ kind: 'email' })} disabled={busy} />
          </View>
        </Card>
      </Section>
    )
  }

  const emailField = (
    <TextField
      label="Email"
      value={email}
      onChangeText={(t) => {
        setEmail(t)
        setFieldError(null)
      }}
      error={fieldError}
      placeholder="name@example.com"
      inputMode="email"
      autoComplete="email"
      textContentType="emailAddress"
      autoCapitalize="none"
      autoCorrect={false}
      autoFocus={moved}
      enterKeyHint={step.kind === 'email' ? 'send' : 'next'}
      onSubmitEditing={step.kind === 'email' ? () => void send() : () => passwordField.current?.focus()}
      editable={!busy}
    />
  )

  if (step.kind === 'password') {
    return (
      <Section key="password" title="Sign in with a password" note="For accounts that were given one, such as an app store reviewer’s.">
        <Card>
          {emailField}
          <TextField
            ref={passwordField}
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            autoCapitalize="none"
            autoCorrect={false}
            enterKeyHint="go"
            onSubmitEditing={() => void withPassword()}
            editable={!busy}
          />
          {banner}
          <Button label={busy ? 'Signing in…' : 'Sign in'} variant="primary" onPress={() => void withPassword()} disabled={busy || password === ''} />
          <View style={LINKS}>
            <Button label="Use an emailed code" variant="plain" size="small" onPress={() => go({ kind: 'email' })} disabled={busy} />
          </View>
        </Card>
      </Section>
    )
  }

  return (
    <Section key="email" title={title} note={note}>
      <Card>
        {emailField}
        {banner}
        <Button label={busy ? 'Sending…' : 'Email me a code'} variant="primary" onPress={() => void send()} disabled={busy} />
        <View style={LINKS}>
          <Button label="Use password" variant="plain" size="small" onPress={() => go({ kind: 'password' })} disabled={busy} />
        </View>
      </Card>
    </Section>
  )
}
