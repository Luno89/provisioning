import { describe, it, expect } from 'vitest'
import { projectRemovalLines, projectRemovalProgress } from './project-removal-text'

describe('what the delete-project popup says', () => {
  it('lists what goes with the project', () => {
    expect(projectRemovalLines({
      name: 'shop', repository: 'koala-bo/shop', trees: [{ id: 't1', name: 'Shop features', leaves: 3, conversations: 1 }], keptConversations: 2, builds: 1, apps: ['shop'], files: { server: 'minio', folder: 'shop' }, state: { state: 'none' },
    })).toEqual([
      'The app “shop” running on its cluster, with its databases and files',
      'The repository koala-bo/shop, with its history and its build webhook',
      'Its files: the folder shop on minio, with everything in it',
      'The tree “Shop features”, with 3 leaves, their tasks and plans, 1 conversation and its sandbox',
      '1 build and their logs',
      'Its secrets, and anything still running for it',
    ])
  })

  it('says which step it is on, or why it stopped', () => {
    expect(projectRemovalProgress({ state: 'running', done: ['workflows'] })).toBe('Removing its apps from their clusters (2 of 7)')
    expect(projectRemovalProgress({ state: 'running', done: ['workflows', 'apps'] })).toBe('Deleting its workspaces (3 of 7)')
    expect(projectRemovalProgress({ state: 'failed', reason: 'Gitea is down' })).toBe('Stopped: Gitea is down')
    expect(projectRemovalProgress({ state: 'finished' })).toBe('Deleted')
  })
})
