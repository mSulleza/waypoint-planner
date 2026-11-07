import { useState } from 'react'
import { View } from 'react-native'
import { asDataError, type DataError } from '@/data/errors'
import { pickPdfFile, type PickedPdf } from '@/data/pdf-file'
import { PASSWORD_CODES } from '@/data/pdf-read'
import { Banner } from '@/ui/Banner'
import { Button } from '@/ui/Button'
import { Text } from '@/ui/Text'
import { TextField } from '@/ui/TextField'
import { SPACE } from '@/ui/tokens'

export interface PdfFillProps<T> {
  label: string
  read: (file: PickedPdf, password: string | null) => Promise<T>
  // The sheet fills its own draft; nothing is saved here.
  onRead: (answer: T, file: PickedPdf) => void
  disabled?: boolean
}

const isPasswordCode = (code: string | null) => (PASSWORD_CODES as readonly (string | null)[]).includes(code)

// Fill from PDF on a sheet: choose a file, type its password when it is locked, and hand what DeepSeek read to the sheet, whose own checks run before Save.
export function PdfFill<T>({ label, read, onRead, disabled = false }: PdfFillProps<T>) {
  const [reading, setReading] = useState<string | null>(null)
  const [locked, setLocked] = useState<{ file: PickedPdf; password: string; wrong: string | null } | null>(null)
  const [failure, setFailure] = useState<DataError | null>(null)

  const run = async (file: PickedPdf, password: string | null) => {
    setReading(file.name)
    setFailure(null)
    try {
      const answer = await read(file, password)
      setLocked(null)
      onRead(answer, file)
    } catch (error) {
      const e = asDataError(error)
      if (isPasswordCode(e.code)) setLocked({ file, password: '', wrong: e.code === 'wrong_password' ? e.message : null })
      else setFailure(e)
    } finally {
      setReading(null)
    }
  }
  const choose = async () => {
    setFailure(null)
    setLocked(null)
    const file = await pickPdfFile().catch(() => null)
    if (file) await run(file, null)
  }
  const open = () => {
    if (locked && locked.password !== '' && reading === null) void run(locked.file, locked.password)
  }

  return (
    <View style={{ gap: SPACE[2] }}>
      <View style={{ flexDirection: 'row', marginHorizontal: -SPACE[3] }}>
        <Button label={reading ? `Reading ${reading}…` : label} icon="file-text" variant="plain" size="small" onPress={() => void choose()} disabled={disabled || reading !== null} />
      </View>
      {locked ? (
        <View style={{ gap: SPACE[2] }}>
          <TextField
            label={`Password for ${locked.file.name}`}
            hint="Used once to open the file, and never kept."
            value={locked.password}
            onChangeText={(password) => setLocked({ ...locked, password, wrong: null })}
            secureTextEntry
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            error={locked.wrong}
            editable={reading === null}
            onSubmitEditing={open}
          />
          <View style={{ flexDirection: 'row', gap: SPACE[2] }}>
            <Button label="Open" size="small" onPress={open} disabled={reading !== null || locked.password === ''} />
            <Button label="Cancel" variant="plain" size="small" onPress={() => setLocked(null)} disabled={reading !== null} />
          </View>
        </View>
      ) : null}
      {failure ? <Banner tone="negative" title="Not read" body={failure.message} detail={failure.technical ?? undefined} /> : null}
      <Text variant="footnote" tone="text2">
        DeepSeek reads the PDF’s text on Waypoint’s server, with card and account numbers masked. Nothing is saved until you press Save.
      </Text>
    </View>
  )
}
