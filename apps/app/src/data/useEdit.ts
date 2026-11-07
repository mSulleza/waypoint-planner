import { useMutation, useQueryClient } from '@tanstack/react-query'
import { sendEdit, type Edit } from './edits'
import { DataError } from './errors'
import { useWritesEnabled } from './hooks'
import { refreshAfterWrite } from './query'
import { getSupabase } from './supabase'

// One To-do mark. It finishes once the household has reloaded, so the row on screen already shows the change; a refusal reloads too, since the row may have changed elsewhere.
export function useEdit() {
  const queryClient = useQueryClient()
  const writable = useWritesEnabled()
  return useMutation({
    mutationFn: async (edit: Edit) => {
      if (!writable) throw new DataError('read_only', 'Saving is off offline and in samples.')
      await sendEdit(getSupabase(), edit)
    },
    onSettled: (_data, error) => (error instanceof DataError && error.kind === 'read_only' ? undefined : refreshAfterWrite(queryClient)),
  })
}
