import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebounce, DEBOUNCE_MS } from './use-debounce'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useDebounce', () => {
  it('returns the initial value immediately, so nothing renders empty', () => {
    const { result } = renderHook(() => useDebounce('meta-llama/Llama-3.1-8B'))
    expect(result.current).toBe('meta-llama/Llama-3.1-8B')
  })

  it('withholds a change until the input settles', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounce(v), {
      initialProps: { v: 'a' },
    })
    rerender({ v: 'ab' })
    expect(result.current).toBe('a')
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS) })
    expect(result.current).toBe('ab')
  })

  it('collapses a burst of keystrokes into one update', () => {
    const { result, rerender } = renderHook(({ v }) => useDebounce(v), {
      initialProps: { v: 'L' },
    })
    for (const v of ['Ll', 'Lla', 'Llam', 'Llama']) {
      rerender({ v })
      act(() => { vi.advanceTimersByTime(DEBOUNCE_MS - 100) })
    }
    expect(result.current).toBe('L')
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS) })
    expect(result.current).toBe('Llama')
  })

  it('cancels a pending update when unmounted', () => {
    const { rerender, unmount } = renderHook(({ v }) => useDebounce(v), {
      initialProps: { v: 'a' },
    })
    rerender({ v: 'b' })
    unmount()
    expect(() => act(() => { vi.advanceTimersByTime(DEBOUNCE_MS * 2) })).not.toThrow()
  })
})
