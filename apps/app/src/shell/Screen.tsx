import { useFocusEffect } from 'expo-router'
import Head from 'expo-router/head'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { FlatList, Platform, ScrollView, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent, type ViewStyle } from 'react-native'
import { useSnapshot } from '@/data/hooks'
import type { Notice, Phase } from '@/data/status'
import { Header } from '@/ui/Header'
import { Text } from '@/ui/Text'
import { useTheme } from '@/ui/theme'
import { CONTENT_MAX_WIDTH, GUTTER, SPACE, WIDE_MAX_WIDTH } from '@/ui/tokens'
import { Notices } from './Notices'
import type { ScreenKind } from './shell.model'
import { useAddressBar } from './useAddressBar'

// A long body, such as a month's ledger, drawn as a virtualised list under the screen's content; only the rows near the view are mounted.
export interface ScreenList<T> {
  data: readonly T[]
  keyOf: (item: T) => string
  render: (item: T) => ReactElement
}

export interface ScreenProps<T> {
  title: string
  kind: ScreenKind
  onSettings?: boolean
  // Drawn once the snapshot has loaded; until then the notices say why it has not.
  children?: ReactNode
  // The phases that draw children; onboarding draws for an account with no household.
  phases?: readonly Phase[]
  // Notices the screen itself already says, such as 'No household yet' on onboarding.
  hideNotices?: readonly Notice['id'][]
  // A new value scrolls back to the top, as when a flow moves to its next step.
  scrollKey?: string | number
  // Rows after the content, in the same centred column; drawn only once the snapshot has loaded.
  list?: ScreenList<T>
  // A wider column, for a table with many figures.
  wide?: boolean
  // An account's own page: its lettered tile leads the title, in the colour its rows have.
  accountId?: string
}

const READY: readonly Phase[] = ['ready']

// The page's own scroll, for a screen that pushes a copy of itself and keeps the person's place, as Months does.
export interface ScreenScroll {
  offset: () => number
  // Where a screen that has just mounted opens, once its content has a size.
  scrollTo: (y: number) => void
}

const ScrollContext = createContext<ScreenScroll | null>(null)

export function useScreenScroll(): ScreenScroll | null {
  return useContext(ScrollContext)
}

// The list's first cell holds the notices and the content, so they scroll with the rows under the sticky header.
const TOP = Symbol('top')

const column = { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' } as const

// Below this window height (a phone on its side, or 200% zoom) the header scrolls away, so it never takes a third of the view.
const STICKY_MIN_HEIGHT = 600

// The page's height, which a phone keyboard leaves alone; on the web useWindowDimensions shrinks with it and rebuilt the focused field.
export function useLayoutHeight(): number {
  const { height } = useWindowDimensions()
  const [page, setPage] = useState(() => (Platform.OS === 'web' && typeof window !== 'undefined' ? window.innerHeight : height))
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const onResize = () => setPage(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return Platform.OS === 'web' ? page : height
}
const wideColumn = { ...column, maxWidth: WIDE_MAX_WIDTH } as const

// Every tab and page: the header, the data notices, then the content in a centred column.
export function Screen<T = never>({ title, kind, onSettings, children, phases = READY, hideNotices, scrollKey, list, wide = false, accountId }: ScreenProps<T>) {
  const { colors } = useTheme()
  const sticky = useLayoutHeight() >= STICKY_MIN_HEIGHT ? [0] : undefined
  // The browser scrolls a focused control clear of the sticky header by this much (WCAG 2.4.11).
  const [headerHeight, setHeaderHeight] = useState(0)
  const scrollStyle = [{ flex: 1 }, Platform.OS === 'web' && sticky ? ({ scrollPaddingTop: headerHeight } as ViewStyle) : null]
  const state = useSnapshot()
  const scroll = useRef<ScrollView>(null)
  const rows = useRef<FlatList<T | typeof TOP>>(null)
  const offset = useRef(0)
  // A pushed screen can mount before it has a size, so the offset waits for the first content size.
  const pending = useRef<number | null>(null)
  const page = useMemo<ScreenScroll>(() => ({ offset: () => offset.current, scrollTo: (y) => (pending.current = y) }), [])
  const to = (y: number) => (list ? rows.current?.scrollToOffset({ offset: y, animated: false }) : scroll.current?.scrollTo({ y, animated: false }))
  const onContentSizeChange = (_w: number, h: number) => {
    if (pending.current === null || h <= 0) return
    to(pending.current)
    pending.current = null
  }
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => (offset.current = e.nativeEvent.contentOffset.y)
  useAddressBar()
  useEffect(() => {
    if (scrollKey !== undefined) to(0)
  }, [scrollKey])
  const notices = hideNotices ? { ...state, notices: state.notices.filter((n) => !hideNotices.includes(n.id)) } : state
  const ready = phases.includes(state.phase)
  const content = (
    <View style={[wide ? wideColumn : column, { gap: SPACE[4] }]}>
      <Notices state={notices} />
      <ScrollContext.Provider value={page}>{ready ? children : null}</ScrollContext.Provider>
      {state.loading ? <Text tone="text2">Loading…</Text> : null}
    </View>
  )
  const header = (
    <View onLayout={(e) => setHeaderHeight(Math.ceil(e.nativeEvent.layout.height))}>
      <Header title={title} kind={kind} onSettings={onSettings} wide={wide} accountId={accountId} />
    </View>
  )
  if (list) {
    const data: readonly (T | typeof TOP)[] = ready ? [TOP, ...list.data] : [TOP]
    return (
      <View role="main" style={{ flex: 1, backgroundColor: colors.bg }}>
        <PageTitle title={title} />
        <FlatList
          ref={rows}
          style={scrollStyle}
          data={data}
          keyExtractor={(item) => (item === TOP ? 'top' : list.keyOf(item))}
          renderItem={({ item }) => <View style={{ paddingHorizontal: GUTTER, paddingTop: item === TOP ? SPACE[2] : 0 }}>{item === TOP ? content : <View style={column}>{list.render(item)}</View>}</View>}
          ListHeaderComponent={header}
          stickyHeaderIndices={sticky}
          // Small batches as rows come into reach, so mounting them never holds the main thread for long (spec §11: 50 ms at 4x slowdown).
          initialNumToRender={8}
          maxToRenderPerBatch={5}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: SPACE[12] }}
          onScroll={onScroll}
          onContentSizeChange={onContentSizeChange}
          scrollEventThrottle={16}
        />
      </View>
    )
  }
  return (
    <View role="main" style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageTitle title={title} />
      {/* The header scrolls with the content but sticks to the top, so both share one width beside a scrollbar. */}
      <ScrollView
        ref={scroll}
        style={scrollStyle}
        keyboardShouldPersistTaps="handled"
        stickyHeaderIndices={sticky}
        contentContainerStyle={{ paddingBottom: SPACE[12] }}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={16}
      >
        {header}
        <View style={{ paddingHorizontal: GUTTER, paddingTop: SPACE[2] }}>{content}</View>
      </ScrollView>
    </View>
  )
}

// The browser tab and history name the screen on top. Head waits for an animation frame, which a background tab never draws, so the focused screen also sets it at once.
export function PageTitle({ title }: { title: string }) {
  const text = `${title} · Waypoint`
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') globalThis.document.title = text
    }, [text]),
  )
  return (
    <Head>
      <title>{text}</title>
    </Head>
  )
}
