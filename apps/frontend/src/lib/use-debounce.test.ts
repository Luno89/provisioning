import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebounce, DEBOUNCE_MS } from './use-debounce'

/**
 * The behaviour the three hand-written copies in App.tsx had, asserted once.
 *
 * Each existed because the value feeds a react-query key that hits the Hugging Face API — keying on
 * every keystroke means a request per character.
 */

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useDebounce', () => {
  it('returns the initial value immediately, so nothing renders empty', () => {
    // A first render that returned undefined would blank the field it feeds.
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
    /**
     * The whole point. Typing `Llama` is five renders; without this it is five requests to the
     * Hugging Face API, four of them for prefixes that name nothing.
     */
    const { result, rerender } = renderHook(({ v }) => useDebounce(v), {
      initialProps: { v: 'L' },
    })
    for (const v of ['Ll', 'Lla', 'Llam', 'Llama']) {
      rerender({ v })
      act(() => { vi.advanceTimersByTime(DEBOUNCE_MS - 100) })
    }
    // Nothing has settled yet — each keystroke cancelled the one before it.
    expect(result.current).toBe('L')
    act(() => { vi.advanceTimersByTime(DEBOUNCE_MS) })
    expect(result.current).toBe('Llama')
  })

  it('cancels a pending update when unmounted', () => {
    // Otherwise the timer fires into a component that is gone, which React warns about and which
    // keeps the closed-over value alive.
    const { rerender, unmount } = renderHook(({ v }) => useDebounce(v), {
      initialProps: { v: 'a' },
    })
    rerender({ v: 'b' })
    unmount()
    expect(() => act(() => { vi.advanceTimersByTime(DEBOUNCE_MS * 2) })).not.toThrow()
  })
})
