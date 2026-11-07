import { getDocumentAsync } from 'expo-document-picker'
import { File } from 'expo-file-system'
import type { PickedPdf } from './pdf-file'

// The phone's document picker; the copy in the app's cache is read once.
export async function pickPdfFile(): Promise<PickedPdf | null> {
  const result = await getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true })
  const asset = result.canceled ? undefined : result.assets[0]
  if (!asset) return null
  return { name: asset.name, base64: await new File(asset.uri).base64() }
}
