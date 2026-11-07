import { getDocumentAsync } from 'expo-document-picker'

export interface PickedFile {
  name: string
  text: string
}

// The browser's file dialog; the file is read on this device and never uploaded. Some browsers never report a cancel, so this may not settle.
export async function pickCsvFile(): Promise<PickedFile | null> {
  const result = await getDocumentAsync({ type: ['.csv', 'text/csv', 'text/plain', 'application/vnd.ms-excel'], base64: false })
  const asset = result.canceled ? undefined : result.assets[0]
  if (!asset?.file) return null
  try {
    return { name: asset.name, text: await asset.file.text() }
  } finally {
    URL.revokeObjectURL(asset.uri)
  }
}
