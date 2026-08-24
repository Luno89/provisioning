import { useEffect, useState } from 'react'

/**
 * A value that lags behind its input until the input stops changing.
 *
 * ── WHY IT EXISTS ──
 * `App.tsx` had this written out three times — seven `useState` mirrors and three near-identical
 * effects, all `setTimeout(…, 500)` with a `clearTimeout` cleanup:
 *
 *     const [debouncedTabbyModel, setDebouncedTabbyModel] = useState('')
 *     useEffect(() => {
 *       const t = setTimeout(() => setDebouncedTabbyModel(wizardData.tabbyModel), 500)
 *       return () => clearTimeout(t)
 *     }, [wizardData.tabbyModel])
 *
 * Each one exists for the same reason: the value feeds a react-query key that hits the Hugging Face
 * API, and keying on every keystroke means a request per character.
 *
 * ── WHY 500ms ──
 * Carried over from what those effects used. Long enough that typing a model name like
 * `meta-llama/Llama-3.1-8B` is one request rather than twenty-three, short enough that the size
 * estimate appears while you are still looking at the field.
 */
export const DEBOUNCE_MS = 500

export function useDebounce<T>(value: T, delay: number = DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    // Clearing on every change is what makes this a debounce rather than a throttle: a keystroke
    // inside the window cancels the pending update instead of queueing a second one.
    return () => clearTimeout(timer)
  }, [value, delay])

  return debounced
}
