import { describe, expect, it } from 'vitest'
import { storyLine } from './leaf-types'

const base = { updatedAt: '2026-10-19T15:03:00Z' }
const landed = { at: '2026-10-18T15:00:00Z', outcome: 'merged' as const }

describe('a story in one plain line', () => {
  it('says a done story is done, verified and when it landed', () => {
    expect(storyLine({ ...base, status: 'succeeded', verified: true, landed }, []).text).toBe('Done: verified and landed on main Oct 18')
    expect(storyLine({ ...base, status: 'succeeded', verified: true, landed, review: { verdict: 'sound', model: 'person', at: 'x' } }, []).text).toBe('Done: verified by you and landed on main Oct 18')
    expect(storyLine({ ...base, status: 'succeeded', verified: true }, []).text).toBe('Done: verified; it lands on main when this judge pass ends')
  })

  it('says a story a replan reopened is reopened, with the tasks left, and never that it landed', () => {
    const line = storyLine({ ...base, status: 'pending', verified: true, landed }, [], { done: 1, total: 4 })
    expect(line).toEqual({ text: 'Reopened Oct 19: 3 of 4 tasks to do', reopened: true })
    expect(storyLine({ ...base, status: 'running', landed }, [], { done: 1, total: 4 }).text).toBe('Being worked now (reopened Oct 19): 3 of 4 tasks to do')
  })

  it('names what a story waits on, how many times it failed, and a story still to do', () => {
    expect(storyLine({ ...base, status: 'pending', dependsOn: ['a'] }, [{ id: 'a', title: 'The module', status: 'running' }]).text).toBe('Waits on “The module”')
    expect(storyLine({ ...base, status: 'failed', attempts: [{ attempt: 1, error: 'x', failedAt: 'y' }, { attempt: 2, error: 'x', failedAt: 'y' }] }, []).text).toBe('Failed after 2 attempts')
    expect(storyLine({ ...base, status: 'pending' }, [], { done: 0, total: 2 }).text).toBe('To do: 2 of 2 tasks to do')
    expect(storyLine({ ...base, status: 'cancelled' }, []).text).toBe('Cancelled')
  })
})
