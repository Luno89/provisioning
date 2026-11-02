import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { startedFor } from '../../platform/lib/workflow-owner.js';
import type { StartRunRequest, StartedRun } from '../../engine-host/registries/run-starter.js';
import { WorkspaceBuildService } from './WorkspaceBuildService.js';

const TASK_QUEUE = 'workspace-build-test';

const trees = [
  { id: 't1', ownerId: 'u1', projectIds: ['p1'] },
  { id: 't2', ownerId: 'u1', projectIds: ['p2', 'p1'] },
  { id: 't3', ownerId: 'u2', projectIds: ['p1'] },
];

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await temporalTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

function service(hidden: string[] = []) {
  const started: StartRunRequest[] = [];
  const builds = new WorkspaceBuildService({
    runs: {
      start: async (request): Promise<StartedRun> => {
        await env.client.workflow.start('AgentRunWorkflow', { workflowId: request.runId!, taskQueue: TASK_QUEUE, args: [], ...startedFor(request.ownerId) });
        started.push(request);
        return { runId: request.runId!, agentSlug: request.agentSlug, loopId: 'build-workspace' };
      },
    },
    trees: async () => trees,
    hidden: async () => ({ agents: new Set(hidden) }),
  });
  return { builds, started };
}

describe('starting a workspace build on Temporal', () => {
  it('builds the workspace of each tree whose home is the project, when a push to main changed its file, one workflow for each', async () => {
    const { builds, started } = service();
    const outcome = await builds.pushed({ id: 'p1', ownerId: 'u1' }, 'abcdef1234567890', [{ modified: ['addons/x.py'] }, { added: ['.koala/workspace.json'] }]);

    expect(outcome).toEqual([{ started: true, runId: 'workspace-build-t1-abcdef123456' }]);
    expect(started.map((request) => request.inputs)).toEqual([{ treeId: 't1', commit: 'abcdef1234567890' }]);
    expect((await env.client.workflow.getHandle('workspace-build-t1-abcdef123456').describe()).status.name).toBe('RUNNING');
  });

  it('starts nothing for a push that did not touch the file, or a project with no owner', async () => {
    const { builds, started } = service();
    expect(await builds.pushed({ id: 'p1', ownerId: 'u1' }, 'aaa111', [{ modified: ['README.md'] }])).toEqual([]);
    expect(await builds.pushed({ id: 'p1' }, 'aaa111', [{ removed: ['.koala/workspace.json'] }])).toEqual([]);
    expect(started).toEqual([]);
  });

  it('says so when that commit is already being built, or the workspace extension is switched off', async () => {
    const { builds } = service();
    expect(await builds.start('u1', 't2', 'bbb222')).toEqual({ started: true, runId: 'workspace-build-t2-bbb222' });
    expect(await builds.start('u1', 't2', 'bbb222')).toEqual({ started: false, reason: 'running' });
    expect(await service(['workspace']).builds.start('u1', 't2', 'ccc333')).toEqual({ started: false, reason: 'switched-off' });
    await expect(env.client.workflow.getHandle('workspace-build-t2-ccc333').describe()).rejects.toThrow();
  });
});
