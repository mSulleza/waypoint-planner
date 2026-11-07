import { useCallback } from 'react'
import { maskFigures } from './mask-text'
import { useMask } from './theme'

// Free text as shown: a bank's own words keep any amount in them, which the eye masks like every other figure.
export function useMaskText(): (text: string) => string {
  const { masked } = useMask()
  return useCallback((text: string) => (masked ? maskFigures(text) : text), [masked])
}
