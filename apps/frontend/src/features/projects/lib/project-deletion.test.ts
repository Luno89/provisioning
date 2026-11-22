import { describe, it, expect } from 'vitest'
import { confirmationText, deletionHeadline, deletionLines, keptUntilFrom, latestProgress, longDate } from './project-deletion'
import type { DeletionProgress, ProjectRemovalPreview } from '../types/project-removal'

const at = '2026-11-21T10:00:00.000Z'
const deletion = (progress?: Partial<DeletionProgress>): DeletionProgress | undefined =>
  progress ? { seq: 1, phase: 'deleting', work: [], parts: {}, ...progress } : undefined

const PREVIEW: ProjectRemovalPreview = {
  name: 'shop', repository: 'koala-bo/shop', trees: [{ id: 't1', name: 'Shop features', leaves: 2, conversations: 1 }], keptConversations: 0, builds: 3, apps: ['shop-web'],
  files: { server: 'MinIO', folder: 'projects/shop' },
}

describe('what deleting a project says it does', () => {
  it('says plainly what goes now and what is kept, until the date it names, when it is kept', () => {
    expect(confirmationText(PREVIEW, 'archive', '2027-02-19T10:00:00.000Z')).toEqual({
      now: ['The app “shop-web” running on its cluster, with its databases and files', 'Its secrets', 'Its workspaces, and anything still running for it'],
      kept: {
        until: '19 February 2027',
        lines: ['Its code: the repository koala-bo/shop, with its history', 'The tree “Shop features”, with 2 leaves, their tasks and plans and 1 conversation', '3 builds and their logs', 'The files you uploaded: the folder projects/shop on MinIO', 'What Koala remembers for this project only'],
      },
    })
  })

  it('lists everything as deleted now when it is deleted for good', () => {
    const text = confirmationText(PREVIEW, 'permanent', '2027-02-19T10:00:00.000Z')
    expect(text.kept).toBeUndefined()
    expect(text.now).toEqual([
      'The app “shop-web” running on its cluster, with its databases and files', 'Its secrets', 'Its workspaces, and anything still running for it',
      'Its code: the repository koala-bo/shop, with its history', 'The tree “Shop features”, with 2 leaves, their tasks and plans and 1 conversation', '3 builds and their logs', 'The files you uploaded: the folder projects/shop on MinIO', 'What Koala remembers for this project only',
    ])
  })

  it('works out the date it is kept until as 90 days from now', () => {
    expect(keptUntilFrom(new Date(at))).toBe('2027-02-19T10:00:00.000Z')
    expect(longDate('2027-02-19T10:00:00.000Z')).toBe('19 February 2027')
  })
})

describe('where a deletion stands, in plain words', () => {
  it('shows each running thing with what is really happening to it', () => {
    expect(deletionLines(deletion({
      work: [
        { workflowId: 'a', type: 'AgentRunWorkflow', startedAt: at, state: 'stopping', what: 'Tree run: Grow the tree' },
        { workflowId: 'b', type: 'AgentRunWorkflow', startedAt: at, state: 'stopped', what: 'Building a project' },
        { workflowId: 'c', type: 'AgentRunWorkflow', startedAt: at, state: 'restarting', what: 'Koala at work', worker: 'worker-engine-7d9f' },
        { workflowId: 'd', type: 'AgentRunWorkflow', startedAt: at, state: 'restarted', what: 'Saving files you uploaded', worker: 'worker-engine-7d9f' },
        { workflowId: 'e', type: 'AgentRunWorkflow', startedAt: at, state: 'gone', what: 'Deploying shop-web', worker: 'worker-cluster-55c1' },
      ],
    }))).toEqual([
      'Tree run: Grow the tree: stopping',
      'Building a project: stopped',
      'Koala at work: worker-engine-7d9f not answering: restarting',
      'Saving files you uploaded: worker-engine-7d9f restarted',
      'Deploying shop-web: worker-cluster-55c1 not answering: it is gone',
    ])
  })

  it('names each program a running thing started that was killed as it stopped', () => {
    expect(deletionLines(deletion({
      work: [
        { workflowId: 'a', type: 'AgentRunWorkflow', startedAt: at, state: 'stopped', what: 'Deploying shop-web', killed: ['terraform', 'kubectl'] },
        { workflowId: 'b', type: 'AgentRunWorkflow', startedAt: at, state: 'stopped', what: 'Building a project', killed: [] },
      ],
    }))).toEqual([
      'Deploying shop-web: stopped',
      'terraform: killed',
      'kubectl: killed',
      'Building a project: stopped',
    ])
  })

  it('shows a service it needs that is down, since when and why, and that it carries on when the service is back', () => {
    expect(deletionLines(deletion({
      parts: { secrets: { state: 'deleting', deleted: 0 } },
      down: [{ step: 'RemoveProjectSecretsActivity', dependency: 'infisical', name: 'Infisical', since: '2026-11-21T10:05:00.000Z', reason: 'it cannot be reached: ECONNREFUSED' }],
    }))).toEqual([
      'Secrets: deleting',
      'Infisical is down since 21 November 2026, 10:05 UTC: it cannot be reached: ECONNREFUSED. The deletion carries on when it is back.',
    ])
  })

  it('counts what it deletes going down', () => {
    expect(deletionLines(deletion({
      parts: {
        apps: { state: 'deleting', left: 2, deleted: 1 },
        workspaces: { state: 'deleting', deleted: 0 },
        secrets: { state: 'deleted', left: 0, deleted: 4 },
        records: { state: 'deleted', left: 0, deleted: 340 },
      },
    }))).toEqual(['Apps: 2 left, 1 removed', 'Workspaces: deleting', 'Secrets: 4 deleted', 'Trees, chats, runs and builds: 340 records deleted'])
  })

  it('heads with Deleting until it ends, and never says Deleted while it is stuck', () => {
    expect(deletionHeadline(deletion())).toBe('Deleting')
    expect(deletionHeadline(deletion({ problem: 'Gitea refused to delete koala-bo/shop: 403' }))).toBe('Not deleted yet: Gitea refused to delete koala-bo/shop: 403')
    expect(deletionHeadline(deletion({ phase: 'archived', keptUntil: '2027-02-19T10:00:00.000Z' }))).toBe('Deleted — kept until 19 February 2027')
    expect(deletionHeadline(deletion({ phase: 'deleted' }))).toBe('Deleted for good')
  })

  it('keeps the newest of two copies, whichever came last', () => {
    const older = deletion({ seq: 2 })
    const newer = deletion({ seq: 5 })
    expect(latestProgress(newer, older)).toBe(newer)
    expect(latestProgress(older, newer)).toBe(newer)
    expect(latestProgress(undefined, older)).toBe(older)
    expect(latestProgress(undefined, undefined)).toBeUndefined()
  })
})
