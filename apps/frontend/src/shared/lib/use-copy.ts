import { useCallback, useEffect, useRef, useState } from 'react'

export type CopyState = 'idle' | 'copied' | 'failed'

export const COPIED_FOR_MS = 2000

export function useCopy(): { state: CopyState; copy: (text: string) => void; reset: () => void } {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const reset = useCallback(() => {
    clearTimeout(timer.current)
    setState('idle')
  }, [])
  const copy = useCallback((text: string) => {
    clearTimeout(timer.current)
    if (!navigator.clipboard) {
      setState('failed')
      return
    }
    navigator.clipboard.writeText(text).then(() => {
      setState('copied')
      timer.current = setTimeout(() => setState('idle'), COPIED_FOR_MS)
    }, () => setState('failed'))
  }, [])
  return { state, copy, reset }
}
