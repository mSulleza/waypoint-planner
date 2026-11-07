import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { AccessibilityInfo, Animated, Easing, Modal, Platform, ScrollView, View, useWindowDimensions, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from './Button'
import { sheetMotion } from './motion'
import { Text } from './Text'
import { useReduceMotion, useTheme } from './theme'
import { GUTTER, RADII, SHEET_SHADOW, SPACE } from './tokens'

export interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  // Where focus lands on open; a destructive confirm passes its Cancel button, the Add sheet its amount. Otherwise the first control.
  initialFocus?: RefObject<{ focus: () => void } | null>
  // Called once the closing animation has finished, so a sheet route can leave without cutting it short.
  onExited?: () => void
  // A new value scrolls the sheet back to its top, as when a picker moves to its next step.
  scrollKey?: string | number
}

const WIDE = 640
const useNativeDriver = Platform.OS !== 'web'

// A managed dialog: focus moves in, stays in and returns on close (react-native-web's Modal), Escape and Android Back close it.
export function Sheet({ open, onClose, title, children, initialFocus, onExited, scrollKey }: SheetProps) {
  const { colors } = useTheme()
  const reduceMotion = useReduceMotion()
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const [mounted, setMounted] = useState(open)
  const visibility = useRef(new Animated.Value(0)).current
  const exited = useRef(onExited)
  const scroll = useRef<ScrollView>(null)
  if (open && !mounted) setMounted(true)

  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false })
  }, [scrollKey])

  const focusOnOpen = useRef(initialFocus)
  useEffect(() => {
    exited.current = onExited
    focusOnOpen.current = initialFocus
  })

  useEffect(() => {
    if (!mounted) return
    const m = sheetMotion(open ? 'enter' : 'exit', reduceMotion)
    const anim = Animated.timing(visibility, { toValue: open ? 1 : 0, duration: m.duration, easing: Easing.bezier(...m.easing), useNativeDriver })
    anim.start(({ finished }) => {
      if (!finished) return
      // On phones the screen reader's focus moves once the sheet is in place; the web moves keyboard focus below.
      if (open && Platform.OS !== 'web' && focusOnOpen.current?.current) AccessibilityInfo.sendAccessibilityEvent(focusOnOpen.current.current as unknown as HostInstance, 'focus')
      if (open) return
      setMounted(false)
      exited.current?.()
    })
    return () => anim.stop()
  }, [open, mounted, reduceMotion, visibility])

  useEffect(() => {
    if (!open || !mounted || Platform.OS !== 'web' || !initialFocus) return
    const frame = requestAnimationFrame(() => initialFocus.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, mounted, initialFocus])

  const wide = width >= WIDE
  const rise = sheetMotion('enter', reduceMotion).translateY[0]
  const translateY = visibility.interpolate({ inputRange: [0, 1], outputRange: [rise, 0] })
  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} aria-label={title} statusBarTranslucent navigationBarTranslucent>
      <View style={{ flex: 1, justifyContent: wide ? 'center' : 'flex-end', alignItems: 'center', padding: wide ? SPACE[6] : 0 }}>
        <Animated.View
          aria-hidden
          onStartShouldSetResponder={() => true}
          onResponderRelease={onClose}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim, opacity: visibility }}
        />
        <Animated.View
          accessibilityViewIsModal
          style={{
            width: '100%',
            maxWidth: wide ? 480 : undefined,
            maxHeight: wide ? height - SPACE[12] : height - insets.top - SPACE[6],
            backgroundColor: colors.surface,
            borderRadius: RADII.sheet,
            borderBottomLeftRadius: wide ? RADII.sheet : 0,
            borderBottomRightRadius: wide ? RADII.sheet : 0,
            boxShadow: SHEET_SHADOW,
            paddingBottom: wide ? 0 : insets.bottom,
            opacity: visibility,
            transform: [{ translateY }],
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2], paddingLeft: GUTTER + SPACE[1], paddingRight: SPACE[2], paddingTop: SPACE[2] }}>
            <Text variant="title2" level={2} style={{ flex: 1 }}>
              {title}
            </Text>
            <Button label="Close" icon="x" iconOnly variant="icon" onPress={onClose} />
          </View>
          <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: GUTTER + SPACE[1], paddingTop: SPACE[2], gap: SPACE[4] }}>
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  )
}
