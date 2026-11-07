import { getDocumentAsync } from 'expo-document-picker'
import { File } from 'expo-file-system'
import type { PickedFile } from './csv-file'

// The phone's document picker; the copy in the app's cache is read once, so the file never leaves the device.
export async function pickCsvFile(): Promise<PickedFile | null> {
  const result = await getDocumentAsync({ type: '*/*', copyToCacheDirectory: true })
  const asset = result.canceled ? undefined : result.assets[0]
  if (!asset) return null
  return { name: asset.name, text: await new File(asset.uri).text() }
}
