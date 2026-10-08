import { describe, it, expect } from 'vitest'
import { triggerLabel } from './shared'

describe('what started a scenario run', () => {
  it('names every kind of run the bench starts', () => {
    expect([
      triggerLabel(undefined),
      triggerLabel({ kind: 'manual' }),
      triggerLabel({ kind: 'full' }),
      triggerLabel({ kind: 'changed', agents: ['koala', 'research'] }),
      triggerLabel({ kind: 'practice', agent: 'koala', practiceId: 'p1' }),
      triggerLabel({ kind: 'prompt-change', agent: 'judge', changeId: 'c1' }),
    ]).toEqual([
      'by hand',
      'by hand',
      'bench, everything',
      'bench, changed koala, research',
      'bench, trying a practice for koala',
      'bench, comparing a prompt for judge',
    ])
  })
})
