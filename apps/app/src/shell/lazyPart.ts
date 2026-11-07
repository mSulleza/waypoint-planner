import { createElement, lazy, useState, useSyncExternalStore, type ComponentType, type LazyExoticComponent } from 'react'

export type FailedProps<P> = P & { retry: () => void }

// A screen part whose code loads apart from the first screen; after a failed fetch it shows `failed`, whose Retry fetches again, as does the next screen that asks.
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>, failed: ComponentType<FailedProps<P>>): () => LazyExoticComponent<ComponentType<P>> {
  const listeners = new Set<() => void>()
  let broken = false
  const Failed: ComponentType<P> = (props: P) => createElement(failed, { ...props, retry })
  const make = (): LazyExoticComponent<ComponentType<P>> =>
    lazy<ComponentType<P>>(() =>
      load().then(
        (part) => ({ default: part }),
        () => {
          broken = true
          return { default: Failed }
        },
      ),
    )
  let current = make()
  const renew = () => {
    broken = false
    current = make()
  }
  function retry() {
    renew()
    for (const listener of listeners) listener()
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const read = () => current
  return function usePart() {
    useState(() => (broken ? renew() : undefined))
    return useSyncExternalStore(subscribe, read, read)
  }
}
