export const DURATION = { press: 100, fade: 150, move: 250, sheet: 350 } as const

export type Bezier = readonly [number, number, number, number]

export const EASING = {
  standard: [0.2, 0, 0, 1],
  enter: [0.05, 0.7, 0.1, 1],
  exit: [0.3, 0, 0.8, 0.15],
} as const satisfies Record<string, Bezier>

export type Phase = 'enter' | 'exit'

export interface Transition {
  kind: 'fade' | 'rise'
  opacity: readonly [number, number]
  translateY: readonly [number, number]
  duration: number
  easing: Bezier
}

export const SHEET_RISE = 32

// Under Reduce Motion every transition is this fade: no movement, no bounce.
export function fade(phase: Phase): Transition {
  return { kind: 'fade', opacity: phase === 'enter' ? [0, 1] : [1, 0], translateY: [0, 0], duration: DURATION.fade, easing: EASING.standard }
}

export function sheetMotion(phase: Phase, reduceMotion: boolean): Transition {
  if (reduceMotion) return fade(phase)
  return phase === 'enter'
    ? { kind: 'rise', opacity: [0, 1], translateY: [SHEET_RISE, 0], duration: DURATION.sheet, easing: EASING.enter }
    : { kind: 'rise', opacity: [1, 0], translateY: [0, SHEET_RISE], duration: Math.round(DURATION.sheet * 0.75), easing: EASING.exit }
}
