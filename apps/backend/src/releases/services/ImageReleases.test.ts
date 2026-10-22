import { describe, it, expect } from 'vitest';
import { ImageReleases, type ImageReleaseDeps } from './ImageReleases.js';
import type { StartRunRequest } from '../../engine-host/registries/run-starter.js';
import type { PipelineRunMetadata, ProjectMetadata } from '../../platform/lib/types.js';

const project = { id: 'p1', name: 'Api', ownerId: 'bo', autoDeployOnBuild: true } as ProjectMetadata;
const run = { id: 'b2', projectId: 'p1', commitSha: 'def', imageTag: 'reg/api:def' } as PipelineRunMetadata;

const setup = (over: Partial<ImageReleaseDeps> = {}) => {
  const started: StartRunRequest[] = [];
  const notes: unknown[] = [];
  const releases = new ImageReleases({
    runs: { start: async (request) => { started.push(request); } },
    deployedTag: async () => undefined,
    noteOnBuild: async (note) => { notes.push(note); },
    stamp: () => 's1',
    ...over,
  });
  return { releases, started, notes };
};

describe('releasing an image project\'s build', () => {
  it('starts the replace agent on the build, bound to the project, as its owner', async () => {
    const { releases, started } = setup();
    expect(await releases.release(project, run)).toBe('started');
    expect(started).toEqual([{ ownerId: 'bo', agentSlug: 'release-replace', message: 'Deploy the build.', runId: 'release-p1-b2~s1', inputs: { ownerId: 'bo', projectId: 'p1', pipelineRunId: 'b2' }, bound: { projectId: 'p1' } }]);
  });

  it('deploys nothing for a project that does not deploy its builds', async () => {
    const { releases, started } = setup();
    expect(await releases.release({ ...project, autoDeployOnBuild: false }, run)).toBe('not-auto-deployed');
    expect(started).toEqual([]);
  });

  it('skips a build that changed nothing the app is built from since the one deployed, and says why on the build', async () => {
    const { releases, started, notes } = setup({ deployedTag: async () => 'abc', decide: async (_p, since, commit) => ({ release: false, reason: `only docs changed between ${since} and ${commit}` }) });
    expect(await releases.release(project, run)).toEqual({ skipped: 'only docs changed between abc and def' });
    expect(notes).toEqual([{ id: 'b2', releaseSkipped: 'only docs changed between abc and def' }]);
    expect(started).toEqual([]);
  });

  it('waits for a secret only the person can enter, saying which on the build', async () => {
    const { releases, started, notes } = setup({ ensureSecrets: async () => ({ waiting: ['STRIPE_KEY'] }) });
    expect(await releases.release(project, run)).toEqual({ refused: 'waiting for the person to enter STRIPE_KEY' });
    expect(notes).toEqual([{ id: 'b2', releaseRefused: 'waiting for the person to enter STRIPE_KEY' }]);
    expect(started).toEqual([]);
  });
});
