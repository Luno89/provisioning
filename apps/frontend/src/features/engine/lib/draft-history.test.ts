import { describe, it, expect } from 'vitest'
import { HISTORY_LIMIT, record, redo, startHistory, undo } from './draft-history'

describe('undo and redo', () => {
  it('steps back and forward through changes, and a new change forgets what was undone', () => {
    let history = record(record(startHistory('a'), 'b'), 'c')

    history = undo(undo(history))
    expect(history.present).toBe('a')
    history = redo(history)
    expect(history.present).toBe('b')
    history = record(history, 'd')
    expect(redo(history).present).toBe('d')
    expect(undo(history).present).toBe('b')
  })

  it('folds a run of changes to the same thing, like typing into one field, into one undo', () => {
    let history = startHistory('')
    for (const typed of ['h', 'he', 'hel']) history = record(history, typed, 'label:turn')
    history = record(history, 'moved')

    expect(undo(history).present).toBe('hel')
    expect(undo(undo(history)).present).toBe('')
  })

  it('does nothing past either end, ignores a change to the same value, and keeps a bounded past', () => {
    const start = startHistory(0)
    expect(undo(start)).toBe(start)
    expect(redo(start)).toBe(start)
    expect(record(start, 0)).toBe(start)

    let history = start
    for (let step = 1; step <= HISTORY_LIMIT + 20; step += 1) history = record(history, step)
    expect(history.past).toHaveLength(HISTORY_LIMIT)
  })
})
