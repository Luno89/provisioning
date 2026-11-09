import { describe, expect, it } from 'vitest'
import { dependencyLines } from './dependency-lines'
import type { DependencyDown } from '../api/infrastructure'

const at = (iso: string) => `at ${iso}`
const gitea: DependencyDown = { dependency: 'gitea', name: 'Gitea', since: '2026-11-08T10:05:00.000Z', reason: 'it refused the connection (ECONNREFUSED)', process: 'worker-engine' }
const root: DependencyDown = { dependency: 'root', name: 'Koala\'s root', since: '2026-11-08T10:10:00.000Z', reason: 'this instance\'s connection to it is closed', process: 'backend', where: 'https://app.koala.dev' }

describe('the item Needs attention shows for a dependency that is down', () => {
  it('says which dependency is not answering, since when and why, and which process saw it', () => {
    expect(dependencyLines([gitea], at)).toEqual([{
      key: 'gitea',
      root: false,
      label: 'Not answering',
      title: 'Gitea',
      text: 'Gitea isn\'t answering since at 2026-11-08T10:05:00.000Z: it refused the connection (ECONNREFUSED)',
      seenBy: 'Seen by the engine worker',
    }])
  })

  it('is one item for a dependency several processes saw down, since the first saw it, with its reason, naming every one of them', () => {
    const fromBackend: DependencyDown = { ...gitea, since: '2026-11-08T10:01:00.000Z', reason: 'it did not answer in time (UND_ERR_CONNECT_TIMEOUT)', process: 'backend' }
    const fromCluster: DependencyDown = { ...gitea, since: '2026-11-08T10:07:00.000Z', process: 'worker-cluster' }
    expect(dependencyLines([gitea, fromCluster, fromBackend], at)).toEqual([{
      key: 'gitea',
      root: false,
      label: 'Not answering',
      title: 'Gitea',
      text: 'Gitea isn\'t answering since at 2026-11-08T10:01:00.000Z: it did not answer in time (UND_ERR_CONNECT_TIMEOUT)',
      seenBy: 'Seen by this Koala\'s backend, the engine worker and the cluster worker',
    }])
  })

  it('says root is not answering in the words it always used, naming root\'s address', () => {
    expect(dependencyLines([root], at)[0]).toMatchObject({
      key: 'root',
      root: true,
      label: 'Root not answering',
      title: 'https://app.koala.dev',
      text: 'Your instance has not reached Koala\'s root since at 2026-11-08T10:10:00.000Z. Signing in through root and your addresses may not work; everything here keeps running.',
    })
  })

  it('puts root first, then the rest by how long they have been down', () => {
    const temporal: DependencyDown = { ...gitea, dependency: 'temporal', name: 'Temporal', since: '2026-11-08T09:00:00.000Z', process: 'backend' }
    expect(dependencyLines([gitea, root, temporal], at).map((line) => line.key)).toEqual(['root', 'temporal', 'gitea'])
  })
})
