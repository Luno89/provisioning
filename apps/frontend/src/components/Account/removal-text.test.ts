import { describe, it, expect } from 'vitest'
import { confirmMatches, refusalBlockers, removalText } from './removal-text'

describe('saying how a removal is going', () => {
  it('names the step under way, counting from the first', () => {
    expect(removalText({ state: 'running', done: [] })).toBe('stopping its runs (1 of 6)')
    expect(removalText({ state: 'running', done: ['workflows', 'workspaces', 'secrets'] })).toBe('removing its machines from the mesh (4 of 6)')
  })

  it('says when it stopped and why, or that it is done', () => {
    expect(removalText({ state: 'failed', reason: 'Gitea would not delete the user' })).toBe('Stopped: Gitea would not delete the user')
    expect(removalText({ state: 'finished' })).toBe('Removed')
    expect(removalText({ state: 'none' })).toBe('Waiting to start')
  })
})

describe('confirming a removal', () => {
  it('takes the email in any case, with stray spaces', () => {
    expect(confirmMatches(' Bo@Example.com ', 'bo@example.com')).toBe(true)
    expect(confirmMatches('bo', 'bo@example.com')).toBe(false)
  })

  it('reads what the server said stands in the way', () => {
    expect(refusalBlockers({ response: { data: { error: 'no', blockers: ['the app "odoo" is still deployed; remove it first'] } } })).toEqual(['the app "odoo" is still deployed; remove it first'])
    expect(refusalBlockers(new Error('offline'))).toEqual([])
  })
})
