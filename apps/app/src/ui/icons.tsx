import { Platform } from 'react-native'
import Svg, { Circle, Line, Path, Rect, type SvgProps } from 'react-native-svg'
import { useTheme } from './theme'

// Paths from Lucide 0.469.0 (ISC licence, see LUCIDE-LICENSE), drawn on a 24 x 24 grid.
type Part = { d: string } | { cx: number; cy: number; r: number } | { x1: number; y1: number; x2: number; y2: number } | { x: number; y: number; width: number; height: number; rx: number }

const ICONS = {
  plus: [{ d: 'M5 12h14' }, { d: 'M12 5v14' }],
  minus: [{ d: 'M5 12h14' }],
  eye: [{ d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' }, { cx: 12, cy: 12, r: 3 }],
  'eye-off': [
    { d: 'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49' },
    { d: 'M14.084 14.158a3 3 0 0 1-4.242-4.242' },
    { d: 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143' },
    { d: 'm2 2 20 20' },
  ],
  x: [{ d: 'M18 6 6 18' }, { d: 'm6 6 12 12' }],
  check: [{ d: 'M20 6 9 17l-5-5' }],
  'chevron-right': [{ d: 'm9 18 6-6-6-6' }],
  'chevron-left': [{ d: 'm15 18-6-6 6-6' }],
  'chevron-down': [{ d: 'm6 9 6 6 6-6' }],
  'chevron-up': [{ d: 'm18 15-6-6-6 6' }],
  'arrow-left': [{ d: 'm12 19-7-7 7-7' }, { d: 'M19 12H5' }],
  link: [{ d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }, { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }],
  'arrow-up-down': [{ d: 'm21 16-4 4-4-4' }, { d: 'M17 20V4' }, { d: 'm3 8 4-4 4 4' }, { d: 'M7 4v16' }],
  sun: [
    { cx: 12, cy: 12, r: 4 },
    { d: 'M12 2v2' },
    { d: 'M12 20v2' },
    { d: 'm4.93 4.93 1.41 1.41' },
    { d: 'm17.66 17.66 1.41 1.41' },
    { d: 'M2 12h2' },
    { d: 'M20 12h2' },
    { d: 'm6.34 17.66-1.41 1.41' },
    { d: 'm19.07 4.93-1.41 1.41' },
  ],
  calendar: [{ d: 'M8 2v4' }, { d: 'M16 2v4' }, { x: 3, y: 4, width: 18, height: 18, rx: 2 }, { d: 'M3 10h18' }],
  wallet: [
    { d: 'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1' },
    { d: 'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4' },
  ],
  'credit-card': [{ x: 2, y: 5, width: 20, height: 14, rx: 2 }, { x1: 2, y1: 10, x2: 22, y2: 10 }],
  route: [{ cx: 6, cy: 19, r: 3 }, { d: 'M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15' }, { cx: 18, cy: 5, r: 3 }],
  utensils: [{ d: 'M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2' }, { d: 'M7 2v20' }, { d: 'M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7' }],
  'circle-check': [{ cx: 12, cy: 12, r: 10 }, { d: 'm9 12 2 2 4-4' }],
  'circle-alert': [{ cx: 12, cy: 12, r: 10 }, { x1: 12, y1: 8, x2: 12, y2: 12 }, { x1: 12, y1: 16, x2: 12.01, y2: 16 }],
  'triangle-alert': [{ d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }, { d: 'M12 9v4' }, { d: 'M12 17h.01' }],
  info: [{ cx: 12, cy: 12, r: 10 }, { d: 'M12 16v-4' }, { d: 'M12 8h.01' }],
  gauge: [{ d: 'm12 14 4-4' }, { d: 'M3.34 19a10 10 0 1 1 17.32 0' }],
  'file-text': [{ d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }, { d: 'M14 2v4a2 2 0 0 0 2 2h4' }, { d: 'M16 13H8' }, { d: 'M16 17H8' }],
  'rotate-cw': [{ d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }, { d: 'M21 3v5h-5' }],
  settings: [
    {
      d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    },
    { cx: 12, cy: 12, r: 3 },
  ],
} satisfies Record<string, readonly Part[]>

// Hidden from screen readers: the control or word beside it carries the meaning.
const HIDDEN: SvgProps = Platform.OS === 'web' ? { 'aria-hidden': true } : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }

export type IconName = keyof typeof ICONS

export const ICON_NAMES = Object.keys(ICONS) as IconName[]

export interface IconProps {
  name: IconName
  size?: number
  color?: string
  strokeWidth?: number
}

export function Icon({ name, size = 20, color, strokeWidth = 2 }: IconProps) {
  const { colors } = useTheme()
  const parts: readonly Part[] = ICONS[name]
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? colors.text} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...HIDDEN}>
      {parts.map((p, i) =>
        'd' in p ? (
          <Path key={i} d={p.d} />
        ) : 'r' in p ? (
          <Circle key={i} cx={p.cx} cy={p.cy} r={p.r} />
        ) : 'rx' in p ? (
          <Rect key={i} x={p.x} y={p.y} width={p.width} height={p.height} rx={p.rx} />
        ) : (
          <Line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} />
        ),
      )}
    </Svg>
  )
}
