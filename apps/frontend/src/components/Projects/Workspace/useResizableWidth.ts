import { useState, useCallback } from 'react'

export function useResizableWidth(
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number | (() => number),
  options?: {
    collapseThreshold?: number
    defaultCollapsed?: boolean
  },
) {
  const getMax = useCallback(() => (typeof max === 'function' ? max() : max), [max])

  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey))
      const currentMax = typeof max === 'function' ? max() : max
      return Number.isFinite(saved) && saved > 0 ? Math.min(currentMax, Math.max(min, saved)) : defaultWidth
    } catch {
      return defaultWidth
    }
  })

  const [isCollapsed, setIsCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem(`${storageKey}-collapsed`)
      if (saved !== null) return saved === 'true'
      return options?.defaultCollapsed ?? false
    } catch {
      return options?.defaultCollapsed ?? false
    }
  })

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(`${storageKey}-collapsed`, String(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [storageKey])

  const setCollapsed = useCallback((collapsed: boolean) => {
    setIsCollapsed(collapsed)
    try {
      localStorage.setItem(`${storageKey}-collapsed`, String(collapsed))
    } catch {
      /* ignore */
    }
  }, [storageKey])

  const startResize = (direction: 1 | -1) => (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    let latest = startWidth

    const onMove = (ev: MouseEvent) => {
      const delta = direction * (ev.clientX - startX)
      const candidate = startWidth + delta
      const threshold = options?.collapseThreshold ?? (min * 0.4)

      if (candidate < threshold) {
        setCollapsed(true)
        return
      }

      if (isCollapsed) {
        setCollapsed(false)
      }

      const currentMax = getMax()
      latest = Math.min(currentMax, Math.max(min, candidate))
      setWidth(latest)
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      try {
        localStorage.setItem(storageKey, String(latest))
      } catch {
        /* ignore */
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return { width, isCollapsed, toggleCollapse, setCollapsed, startResize }
}
