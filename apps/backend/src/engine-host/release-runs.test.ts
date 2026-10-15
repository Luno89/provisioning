import { describe, it, expect } from 'vitest';
import { engineReleaseRuns } from './release-runs.js';
import type { StartRunRequest } from './registries/run-starter.js';

describe('starting and answering a project\'s release run', () => {
  it('starts the agent as the owner, one run id per release under the project\'s workflow, bound to the project', async () => {
    const started: StartRunRequest[] = [];
    const runs = engineReleaseRuns({ runs: { start: async (request) => { started.push(request); return { runId: request.runId!, agentSlug: request.agentSlug, loopId: 'slots' }; } }, client: () => undefined });
    await runs.start({ projectId: 'p1', ownerId: 'bo', agent: 'release', inputs: { projectId: 'p1' } as never });
    expect(started[0]).toMatchObject({ ownerId: 'bo', agentSlug: 'release', bound: { projectId: 'p1' }, inputs: { projectId: 'p1' } });
    expect(started[0]!.runId).toMatch(/^release-p1~[0-9a-z]+$/);
  });

  it('answers the waiting decision by the step\'s id, and says the project has no run when Temporal has none', async () => {
    const signals: unknown[] = [];
    const client = { getHandle: (id: string) => ({ signal: async (...args: unknown[]) => { signals.push([id, ...args]); }, describe: async () => { throw new Error('workflow not found'); } }) } as never;
    const runs = engineReleaseRuns({ runs: { start: async () => { throw new Error('unused'); } }, client: () => client });
    await runs.answer('p1', 'Cut over');
    await runs.stop('p1');
    expect(signals).toEqual([['release-p1', 'answer', { nodeId: 'decide', value: 'Cut over' }], ['release-p1', 'cancelRun']]);
    expect(await runs.running('p1')).toBe(false);
  });
});
