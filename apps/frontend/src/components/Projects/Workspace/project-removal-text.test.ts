import { describe, it, expect } from 'vitest'
import { projectRemovalLines, projectRemovalProgress } from './project-removal-text'

describe('what the delete-project popup says', () => {
  it('lists what goes with the project', () => {
    expect(projectRemovalLines({
      name: 'shop', repository: 'koala-bo/shop', trees: [{ id: 't1', name: 'Shop features', leaves: 3, conversations: 1 }], keptConversations: 2, builds: 1, blockers: [], state: { state: 'none' },
    })).toEqual([
      'The repository koala-bo/shop, with its history and its build webhook',
      'The tree “Shop features”, with 3 leaves, their tasks and plans, 1 conversation and its sandbox',
      '1 build and their logs',
      'Its secrets, and anything still running for it',
    ])
  })

  it('says which step it is on, or why it stopped', () => {
    expect(projectRemovalProgress({ state: 'running', done: ['workflows'] })).toBe('Deleting its workspaces (2 of 5)')
    expect(projectRemovalProgress({ state: 'failed', reason: 'Gitea is down' })).toBe('Stopped: Gitea is down')
    expect(projectRemovalProgress({ state: 'finished' })).toBe('Deleted')
  })
})
