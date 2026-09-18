export interface DraftHistory<T> {
  past: T[]
  present: T
  future: T[]
  lastMerge?: string | undefined
}

export const HISTORY_LIMIT = 100

export const startHistory = <T>(present: T): DraftHistory<T> => ({ past: [], present, future: [] })

export function record<T>(history: DraftHistory<T>, next: T, mergeKey?: string): DraftHistory<T> {
  if (Object.is(next, history.present)) return history
  if (mergeKey !== undefined && mergeKey === history.lastMerge) {
    return { ...history, present: next, future: [] }
  }
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    lastMerge: mergeKey,
  }
}

export function undo<T>(history: DraftHistory<T>): DraftHistory<T> {
  const previous = history.past.at(-1)
  if (previous === undefined) return history
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] }
}

export function redo<T>(history: DraftHistory<T>): DraftHistory<T> {
  const [next, ...rest] = history.future
  if (next === undefined) return history
  return { past: [...history.past, history.present], present: next, future: rest }
}
