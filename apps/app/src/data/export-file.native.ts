import { File, Paths } from 'expo-file-system'
import { isAvailableAsync, shareAsync } from 'expo-sharing'
import { DataError } from './errors'
import type { ExportFile } from './export'
import type { SavedTo } from './export-file'

// Written to the app's cache, then handed to the share sheet, where the person picks Files, Drive, mail or another app.
export async function saveExportFile(file: ExportFile): Promise<SavedTo> {
  if (!(await isAvailableAsync())) throw new DataError('server', 'This phone cannot share files from Waypoint.')
  const out = new File(Paths.cache, file.name)
  out.create({ overwrite: true })
  out.write(file.text)
  await shareAsync(out.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: file.name })
  return 'share_sheet'
}
