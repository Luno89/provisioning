import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useResizableWidth } from './useResizableWidth.js'

describe('useResizableWidth', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('initializes with defaultWidth and collapsed=false by default', () => {
    const { result } = renderHook(() => useResizableWidth('test-width', 300, 150, 800))
    expect(result.current.width).toBe(300)
    expect(result.current.isCollapsed).toBe(false)
  })

  it('supports dynamic max width function', () => {
    let dynamicMax = 500
    const { result, rerender } = renderHook(() => useResizableWidth('test-dynamic', 300, 150, () => dynamicMax))
    expect(result.current.width).toBe(300)

    // Simulate resizing up to new dynamic max
    dynamicMax = 1200
    rerender()

    // Start resize with mouse move
    act(() => {
      const resizeHandler = result.current.startResize(1)
      resizeHandler({ clientX: 100, preventDefault: () => {} } as any)
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1100 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
    })

    expect(result.current.width).toBe(1200)
  })

  it('toggles collapse and persists to localStorage', () => {
    const { result } = renderHook(() => useResizableWidth('test-collapse', 300, 150, 800))
    expect(result.current.isCollapsed).toBe(false)

    act(() => {
      result.current.toggleCollapse()
    })
    expect(result.current.isCollapsed).toBe(true)
    expect(localStorage.getItem('test-collapse-collapsed')).toBe('true')

    act(() => {
      result.current.toggleCollapse()
    })
    expect(result.current.isCollapsed).toBe(false)
    expect(localStorage.getItem('test-collapse-collapsed')).toBe('false')
  })

  it('snaps to collapsed when resized below collapseThreshold', () => {
    const { result } = renderHook(() =>
      useResizableWidth('test-drag-collapse', 300, 150, 800, { collapseThreshold: 80 }),
    )

    act(() => {
      const resizeHandler = result.current.startResize(1)
      resizeHandler({ clientX: 100, preventDefault: () => {} } as any)
      // Dragging left by 250px -> 300 - 250 = 50px (< 80px threshold)
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: -150 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
    })

    expect(result.current.isCollapsed).toBe(true)
  })
})
