import { describe, it, expect } from 'vitest'
import { buildBoard, featureOnly, featureOrderAfterMove, projectStatus, reachedBy, storiesInOrder, storyOrderAfterMove, withOrder } from './board'
import type { Leaf } from '../../lib/leaf-types'
import type { OdooRelease } from '../../../releases/api/releases'
import type { PipelineRun } from '../PipelineRunRow'
import type { EngineTask } from '../../../engine/api/engine'

const leaf = (id: string, over: Partial<Leaf> = {}): Leaf => ({ id, branchId: 'b1', title: `story ${id}`, status: 'pending', updatedAt: 't', ...over })
const release = (over: Partial<OdooRelease>): OdooRelease => ({ id: 'r', projectId: 'p', pipelineRunId: 'run', commit: 'c0ffee1234', image: 'i', state: 'live', host: 'h', startedAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:05:00Z', ...over })
const run = (over: Partial<PipelineRun>): PipelineRun => ({ id: 'run', projectId: 'p', commitSha: 'abc12345', ref: 'main', status: 'succeeded', startedAt: '2026-10-09T09:00:00Z', ...over })
const task = (id: string, status: EngineTask['status']): EngineTask => ({ id, title: id, doneMeans: '', status, dependsOn: [], ready: true, waitingOn: [] })

describe('the board of a project', () => {
  it('puts each story of each feature in the column its state says, and counts the epic', () => {
    const leaves = [
      leaf('a', { status: 'succeeded', verified: true }),
      leaf('b', { status: 'pending', dependsOn: ['c'] }),
      leaf('c', { status: 'running' }),
      leaf('d', { status: 'cancelled' }),
      leaf('e', { status: 'failed', branchId: 'b2', attempts: [{ attempt: 1, error: 'x', failedAt: 't' }] }),
    ]
    const [epic] = buildBoard({
      trees: [{ id: 't1', name: 'Shop' }],
      branches: [{ id: 'b1', title: 'The field', treeId: 't1' }, { id: 'b2', title: 'The proof', treeId: 't1' }, { id: 'bx', title: 'elsewhere', treeId: 't9' }],
      leaves,
    })
    expect(epic!.features.map((feature) => feature.title)).toEqual(['The field', 'The proof'])
    const field = epic!.features[0]!
    expect(field.columns.verified.map((story) => story.leaf.id)).toEqual(['a'])
    expect(field.columns.blocked[0]).toMatchObject({ waitsOn: ['story c'] })
    expect(field.columns.running.map((story) => story.leaf.id)).toEqual(['c'])
    expect(field.total).toBe(3)
    expect(epic!.features[1]!.columns.failed[0]).toMatchObject({ attempts: 1 })
    expect(epic!.totals).toMatchObject({ verified: 1, blocked: 1, running: 1, failed: 1, todo: 0 })
    expect(epic!.total).toBe(4)
  })

  it('says what a story put aside for its workspace waits for', () => {
    const [epic] = buildBoard({ trees: [{ id: 't1', name: 'Shop' }], branches: [{ id: 'b1', title: 'The field', treeId: 't1' }], leaves: [leaf('a', { waitingFor: { reason: '"Render" waits for the workspace to get dnf wkhtmltopdf', since: 't' } })] })
    expect(epic!.features[0]!.columns.blocked[0]).toMatchObject({ waitsOn: [], waitsForWorkspace: '"Render" waits for the workspace to get dnf wkhtmltopdf' })
    expect(epic!.features[0]!.columns.blocked[0]!.workspaceStuck).toBeUndefined()
  })

  it('says which story waits for you to allow a call, and nothing for a call no story is under', () => {
    const [epic] = buildBoard({
      trees: [{ id: 't1', name: 'Shop' }],
      branches: [{ id: 'b1', title: 'The field', treeId: 't1' }],
      leaves: [leaf('a', { status: 'running' }), leaf('b', { status: 'running' })],
      asking: [
        { runId: 'r1', callId: 'c1', tool: 'delete_project', message: 'm', agent: 'executor', leafId: 'a' },
        { runId: 'r2', callId: 'c2', tool: 'run_command', message: 'm', agent: 'planner' },
      ],
    })
    const running = epic!.features[0]!.columns.running
    expect(running.find((story) => story.leaf.id === 'a')?.asks).toEqual({ tool: 'delete_project', agent: 'executor' })
    expect(running.find((story) => story.leaf.id === 'b')?.asks).toBeUndefined()
  })

  it('says when the workspace a story waits for did not build', () => {
    const [epic] = buildBoard({ trees: [{ id: 't1', name: 'Shop' }], branches: [{ id: 'b1', title: 'The field', treeId: 't1' }], leaves: [leaf('a', { waitingFor: { reason: 'waits for jq', since: 't', stuck: 'not rebuilt: the build failed' } })] })
    expect(epic!.features[0]!.columns.blocked[0]).toMatchObject({ workspaceStuck: 'not rebuilt: the build failed' })
  })

  it('counts a story\'s tasks that are done, leaving out dropped ones, and the ones proposed for it apart', () => {
    const [epic] = buildBoard({
      trees: [{ id: 't1', name: 'Shop' }],
      branches: [{ id: 'b1', title: 'f', treeId: 't1' }],
      leaves: [leaf('a', { status: 'running', tasks: ['x', 'y', 'z', 'gone'] })],
      tasks: [task('x', 'done'), task('y', 'running'), task('z', 'dropped'), { ...task('p', 'proposed'), leafId: 'a' }, { ...task('q', 'proposed'), leafId: 'other' }],
    })
    expect(epic!.features[0]!.columns.running[0]!.tasks).toEqual({ done: 1, total: 2, proposed: 1 })
  })

  it('orders features and the stories in each column by priority, then by when they were made', () => {
    const [epic] = buildBoard({
      trees: [{ id: 't1', name: 'Shop' }],
      branches: [{ id: 'b1', title: 'second', treeId: 't1', priority: 1 }, { id: 'b2', title: 'first', treeId: 't1', priority: 0 }, { id: 'b3', title: 'unranked', treeId: 't1' }],
      leaves: [
        leaf('late', { createdAt: '2026-10-02' }),
        leaf('early', { createdAt: '2026-10-01' }),
        leaf('top', { priority: 0, createdAt: '2026-10-03' }),
      ],
    })
    expect(epic!.features.map((feature) => feature.title)).toEqual(['first', 'second', 'unranked'])
    expect(epic!.features[1]!.columns.todo.map((story) => story.leaf.id)).toEqual(['top', 'early', 'late'])
  })

  it('works out the whole order of a feature after a card is dragged onto another, and of an epic after a feature moves', () => {
    const [epic] = buildBoard({
      trees: [{ id: 't1', name: 'Shop' }],
      branches: [{ id: 'b1', title: 'f', treeId: 't1' }, { id: 'b2', title: 'g', treeId: 't1' }],
      leaves: [leaf('a', { priority: 0 }), leaf('b', { priority: 1, status: 'running' }), leaf('c', { priority: 2 }), leaf('d', { priority: 3 })],
    })
    const feature = epic!.features[0]!
    expect(storiesInOrder(feature)).toEqual(['a', 'b', 'c', 'd'])
    expect(storyOrderAfterMove(feature, 'd', 'a')).toEqual(['d', 'a', 'b', 'c'])
    expect(storyOrderAfterMove(feature, 'a', 'a')).toBeUndefined()
    expect(featureOrderAfterMove(epic!, 'b2', -1)).toEqual(['b2', 'b1'])
    expect(featureOrderAfterMove(epic!, 'b2', 1)).toBeUndefined()
    expect(withOrder([{ id: 'a' }, { id: 'b', priority: 9 }, { id: 'x' }], ['b', 'a'])).toEqual([{ id: 'a', priority: 1 }, { id: 'b', priority: 0 }, { id: 'x' }])
  })

  it('narrows an epic to one feature, counting only its stories', () => {
    const [epic] = buildBoard({
      trees: [{ id: 't1', name: 'Shop' }],
      branches: [{ id: 'b1', title: 'f', treeId: 't1' }, { id: 'b2', title: 'g', treeId: 't1' }],
      leaves: [leaf('a', { status: 'running' }), leaf('b', { status: 'running', branchId: 'b2' }), leaf('c', { status: 'failed', branchId: 'b2' })],
    })
    const only = featureOnly(epic!, epic!.features[1]!)
    expect(only.features.map((feature) => feature.id)).toEqual(['b2'])
    expect(only.totals).toMatchObject({ running: 1, failed: 1, verified: 0 })
    expect(only.total).toBe(2)
  })
})

describe('how far a story\'s work got', () => {
  const landed = { status: 'succeeded' as const, landed: { at: '2026-10-09T09:30:00Z', outcome: 'merged' as const } }

  it('reached what is live when a live release was made after it landed', () => {
    expect(reachedBy(landed, [release({ state: 'live' })], [])).toBe('live')
    expect(reachedBy(landed, [release({ state: 'live', startedAt: '2026-10-09T09:00:00Z' })], [])).toBeUndefined()
    expect(reachedBy(landed, [release({ state: 'preview' })], [])).toBe('preview')
    expect(reachedBy(landed, [], [run({ startedAt: '2026-10-09T09:40:00Z', promotedAt: '2026-10-09T09:45:00Z' })])).toBe('live')
  })

  it('reached nothing when it landed nothing', () => {
    expect(reachedBy({ status: 'succeeded', landed: { at: '2026-10-09T09:30:00Z', outcome: 'nothing' } }, [release({ state: 'live' })], [])).toBeUndefined()
    expect(reachedBy({ status: 'succeeded' }, [release({ state: 'live' })], [])).toBeUndefined()
  })

  it('reached nothing while it is reopened, whatever its earlier work reached', () => {
    expect(reachedBy({ ...landed, status: 'pending' }, [release({ state: 'preview' })], [])).toBeUndefined()
    expect(reachedBy({ ...landed, status: 'running' }, [release({ state: 'live' })], [])).toBeUndefined()
  })
})

describe('what is going on with a project', () => {
  it('names what is live, a preview waiting and the last build', () => {
    const status = projectStatus(
      [release({ id: 'old', state: 'superseded' }), release({ id: 'now', state: 'live', slot: 'a', liveAt: '2026-10-09T10:06:00Z' }), release({ id: 'next', state: 'preview', slot: 'b', commit: 'beef', startedAt: '2026-10-09T11:00:00Z' })],
      [run({ id: 'r1' }), run({ id: 'r2', commitSha: 'beef', startedAt: '2026-10-09T10:59:00Z', releaseSkipped: 'only README.md changed' })],
    )
    expect(status.live).toEqual({ commit: 'c0ffee1234', slot: 'a', since: '2026-10-09T10:06:00Z' })
    expect(status.preview?.id).toBe('next')
    expect(status.lastBuild).toMatchObject({ commit: 'beef', skipped: 'only README.md changed' })
  })

  it('takes an image deploy as live when the project has no releases', () => {
    expect(projectStatus([], [run({ promotedAt: '2026-10-09T09:05:00Z' })]).live).toEqual({ commit: 'abc12345', since: '2026-10-09T09:05:00Z' })
    expect(projectStatus([], [])).toEqual({})
  })

  it('names the version of a tree whose type has versions', () => {
    const types = [{ id: 'odoo-addons', versions: { of: 'Odoo', choices: [{ version: '20', language: 'odoo-20' as const }], default: '20' } }]
    const [odoo, plain] = buildBoard({ trees: [{ id: 't1', name: 'Shop', type: 'odoo-addons', version: '20' }, { id: 't2', name: 'API', type: 'api-service' }], types, branches: [], leaves: [] })
    expect(odoo?.version).toBe('Odoo 20')
    expect(plain).not.toHaveProperty('version')
  })
})

