import { useEffect, useState, type RefObject } from 'react'

export const CARDS_COLUMN_MIN_PX = 900

export type CardsLayout = 'column' | 'tab'

export function useCardsLayout(ref: RefObject<HTMLElement | null>): CardsLayout {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => setWide(element.getBoundingClientRect().width >= CARDS_COLUMN_MIN_PX)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return wide ? 'column' : 'tab'
}
