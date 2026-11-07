import { getDocumentAsync } from 'expo-document-picker'

export interface PickedPdf {
  name: string
  // The file as base64, which is how /api/pdf-read takes it.
  base64: string
}

// Base64 a chunk at a time, since one String.fromCharCode over a whole file overflows the call stack.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

// The browser's file dialog. Some browsers never report a cancel, so this may not settle.
export async function pickPdfFile(): Promise<PickedPdf | null> {
  const result = await getDocumentAsync({ type: ['application/pdf', '.pdf'], base64: false })
  const asset = result.canceled ? undefined : result.assets[0]
  if (!asset?.file) return null
  try {
    return { name: asset.name, base64: bytesToBase64(new Uint8Array(await asset.file.arrayBuffer())) }
  } finally {
    URL.revokeObjectURL(asset.uri)
  }
}
