import type { ExportFile } from './export'

// Where the file went: the browser's downloads, or the phone's share sheet.
export type SavedTo = 'downloads' | 'share_sheet'

// The browser saves the file to its downloads; it is made on this device and sent nowhere.
export async function saveExportFile(file: ExportFile): Promise<SavedTo> {
  const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }))
  const link = globalThis.document.createElement('a')
  link.href = url
  link.download = file.name
  globalThis.document.body.appendChild(link)
  link.click()
  link.remove()
  // Some browsers start reading the URL only after click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloads'
}
