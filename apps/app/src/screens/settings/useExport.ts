import { useRef, useState } from 'react'
import { asDataError, DataError } from '@/data/errors'
import { exportHousehold } from '@/data/export'
import { saveExportFile, type SavedTo } from '@/data/export-file'
import { getSupabase } from '@/data/supabase'

export type ExportState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; name: string; to: SavedTo } | { kind: 'failed'; error: DataError }

// Export data: one export_household call made into a file on this device (spec §10); a press while one runs is ignored.
export function useExport(): { state: ExportState; run: () => void } {
  const [state, setState] = useState<ExportState>({ kind: 'idle' })
  const running = useRef(false)
  const run = () => {
    if (running.current) return
    running.current = true
    setState({ kind: 'busy' })
    void (async () => {
      try {
        const file = await exportHousehold(getSupabase(), new Date())
        if (!file) throw new DataError('server', 'This account has no household to export.')
        setState({ kind: 'done', name: file.name, to: await saveExportFile(file) })
      } catch (error) {
        setState({ kind: 'failed', error: asDataError(error) })
      } finally {
        running.current = false
      }
    })()
  }
  return { state, run }
}

export function exportDetail(state: ExportState): string {
  if (state.kind === 'busy') return 'Making the file…'
  if (state.kind === 'done') return state.to === 'downloads' ? `Downloaded ${state.name}.` : `Made ${state.name}.`
  return 'Your household as a JSON file that Waypoint can import again.'
}
