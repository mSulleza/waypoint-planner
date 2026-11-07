import { useMemo } from 'react'
import { Platform } from 'react-native'
import Svg, { Circle, Path, type SvgProps } from 'react-native-svg'
import { SPARK_DOT, SPARK_MAX_HEIGHT, SPARK_MIN_HEIGHT, SPARK_STROKE, sparkGeometry } from './spark'

export interface SparklineProps {
  values: ArrayLike<number>
  width?: number
  // 24 to 32 pt.
  height?: number
  // The account's identity colour.
  colour: string
}

// Decorative: the printed balance beside it carries the number.
const HIDDEN: SvgProps = Platform.OS === 'web' ? { 'aria-hidden': true } : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }

// A 1.5 px line in the account's colour, with a dot on its last point that ties it to the number printed beside it.
export function Sparkline({ values, width = 80, height = 28, colour }: SparklineProps) {
  const h = Math.max(SPARK_MIN_HEIGHT, Math.min(SPARK_MAX_HEIGHT, height))
  const geo = useMemo(() => sparkGeometry(values, width, h), [values, width, h])
  return (
    <Svg width={width} height={h} {...HIDDEN}>
      {geo ? (
        <>
          <Path d={geo.d} fill="none" stroke={colour} strokeWidth={SPARK_STROKE} strokeLinejoin="round" strokeLinecap="round" />
          <Circle cx={geo.end.x} cy={geo.end.y} r={SPARK_DOT} fill={colour} />
        </>
      ) : null}
    </Svg>
  )
}
