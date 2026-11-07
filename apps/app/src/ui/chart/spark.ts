import { downsample } from './downsample'

export const SPARK_MIN_HEIGHT = 24
export const SPARK_MAX_HEIGHT = 32
export const SPARK_STROKE = 1.5
export const SPARK_DOT = 2.5

export interface SparkGeometry {
  d: string
  end: { x: number; y: number }
  kept: number
}

const round = (n: number) => Math.round(n * 10) / 10

// A word-sized line with no axes: about one point per pixel, each bucket's dip and peak kept, inset so the end dot is never clipped.
export function sparkGeometry(values: ArrayLike<number>, width: number, height: number): SparkGeometry | null {
  if (values.length === 0 || width <= 0) return null
  const indices = downsample(values, Math.max(4, Math.round(width)))
  let lo = Infinity
  let hi = -Infinity
  for (const i of indices) {
    const v = values[i] as number
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  const inset = SPARK_DOT + SPARK_STROKE / 2
  const last = values.length - 1
  const x = (i: number) => (last === 0 ? width / 2 : inset + (i / last) * (width - 2 * inset))
  const y = (v: number) => (hi === lo ? height / 2 : inset + ((hi - v) / (hi - lo)) * (height - 2 * inset))
  const d = indices.map((i, n) => `${n ? 'L' : 'M'}${round(x(i))} ${round(y(values[i] as number))}`).join('')
  return { d, end: { x: round(x(last)), y: round(y(values[last] as number)) }, kept: indices.length }
}
