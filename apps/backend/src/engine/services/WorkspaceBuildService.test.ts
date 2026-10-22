import { describe, expect, it } from 'vitest';
import type { StartRunRequest } from '../../engine-host/registries/run-starter.js';
import { WorkspaceBuildService } from './WorkspaceBuildService.js';

const trees = [
  { id: 't1', ownerId: 'u1', projectIds: ['p1'] },
  { id: 't2', ownerId: 'u1', projectIds: ['p2', 'p1'] },
  { id: 't3', ownerId: 'u2', projectIds: ['p1'] },
];

function service(over: { fails?: Error; hidden?: string[] } = {}) {
  const started: StartRunRequest[] = [];
  const builds = new WorkspaceBuildService({
    runs: { start: async (request) => { if (over.fails) throw over.fails; started.push(request); return { runId: request.runId!, agentSlug: request.agentSlug, loopId: 'build-workspace' }; } },
    trees: async () => trees,
    hidden: async () => ({ agents: new Set(over.hidden ?? []) }),
  });
  return { builds, started };
}

describe('starting a workspace build', () => {
  it('builds the workspace of each tree whose home is the project, when a push to main changed its file', async () => {
    const { builds, started } = service();
    const outcome = await builds.pushed({ id: 'p1', ownerId: 'u1' }, 'abcdef1234567890', [{ modified: ['addons/x.py'] }, { added: ['.koala/workspace.json'] }]);

    expect(outcome).toEqual([{ started: true, runId: 'workspace-build-t1-abcdef123456' }]);
    expect(started).toEqual([{ ownerId: 'u1', agentSlug: 'workspace', message: 'Build the workspace.', inputs: { treeId: 't1', commit: 'abcdef1234567890' }, runId: 'workspace-build-t1-abcdef123456', bound: { treeId: 't1' } }]);
  });

  it('starts nothing for a push that did not touch the file, or a project with no owner', async () => {
    const { builds, started } = service();
    expect(await builds.pushed({ id: 'p1', ownerId: 'u1' }, 'abc', [{ modified: ['README.md'] }])).toEqual([]);
    expect(await builds.pushed({ id: 'p1' }, 'abc', [{ removed: ['.koala/workspace.json'] }])).toEqual([]);
    expect(started).toEqual([]);
  });

  it('says so when that commit is already being built, or the workspace extension is switched off', async () => {
    expect(await service({ fails: Object.assign(new Error('Workflow execution already started'), { name: 'WorkflowExecutionAlreadyStartedError' }) }).builds.start('u1', 't1', 'abc')).toEqual({ started: false, reason: 'running' });
    expect(await service({ hidden: ['workspace'] }).builds.start('u1', 't1', 'abc')).toEqual({ started: false, reason: 'switched-off' });
  });
});
