import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCopy, COPIED_FOR_MS } from './use-copy'

const clipboard = (writeText: (text: string) => Promise<void>) => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useCopy', () => {
  it('says copied only once the clipboard took it, and goes back after a moment', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => undefined)
    clipboard(writeText)
    const { result } = renderHook(() => useCopy())
    await act(async () => { result.current.copy('kubectl get pods') })
    expect(writeText).toHaveBeenCalledWith('kubectl get pods')
    expect(result.current.state).toBe('copied')
    act(() => { vi.advanceTimersByTime(COPIED_FOR_MS) })
    expect(result.current.state).toBe('idle')
  })

  it('says it failed when the browser refuses, rather than claiming it copied', async () => {
    clipboard(async () => { throw new Error('Document is not focused') })
    const { result } = renderHook(() => useCopy())
    await act(async () => { result.current.copy('x') })
    expect(result.current.state).toBe('failed')
  })

  it('says it failed where the page has no clipboard at all', () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const { result } = renderHook(() => useCopy())
    act(() => { result.current.copy('x') })
    expect(result.current.state).toBe('failed')
  })
})
