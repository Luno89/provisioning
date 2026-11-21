import { describe, expect, it } from 'vitest';
import { ImageReleases, type ImageReleaseDeps } from '../services/ImageReleases.js';
import { releaseDecider } from '../services/release-decider.js';
import { noRepositoryRead } from './no-repository.js';
import { deploymentForProject } from '../../projects/lib/project-status.js';
import type { StartRunRequest } from '../../engine-host/registries/run-starter.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { PipelineRunMetadata, ProjectMetadata } from '../../platform/lib/types.js';

const project = { id: 'p1', name: 'Api', ownerId: 'bo', autoDeployOnBuild: true } as ProjectMetadata;
const run = { id: 'b2', projectId: 'p1', commitSha: 'def', imageTag: 'reg/api:def', ref: 'refs/heads/main', status: 'succeeded', startedAt: '1' } as PipelineRunMetadata;

async function setup(db: Database, over: Partial<ImageReleaseDeps> = {}, deployedTag?: string) {
  const started: StartRunRequest[] = [];
  await db.releases.savePipelineRun(run);
  if (deployedTag) await db.infrastructure.saveDeployment({ id: 'd1', name: 'Api', appType: 'gitapp', status: 'running', clusterId: 'c1', ownerId: 'bo', strategy: 'native', gitappProjectId: 'p1', gitappImageTag: `reg/api:${deployedTag}` } as never);
  const releases = new ImageReleases({
    runs: { start: async (request) => { started.push(request); } },
    deployedTag: async (of) => deploymentForProject(of, await db.infrastructure.getDeployments())?.gitappImageTag?.split(':').pop(),
    noteOnBuild: (note) => db.releases.savePipelineRunInfo(note),
    stamp: () => 's1',
    decide: releaseDecider({ trees: db.projects, changed: noRepositoryRead }),
    ...over,
  });
  const stored = async () => (await db.releases.getPipelineRuns()).find((entry) => entry.id === 'b2')!;
  return { releases, started, stored };
}

export function imageReleasesBehaviour(make: () => Promise<Database>): void {
  describe('releasing an image project\'s build', () => {
    it('starts the replace agent on the build, bound to the project, as its owner', async () => {
      const { releases, started } = await setup(await make());
      expect(await releases.release(project, run)).toBe('started');
      expect(started).toEqual([{ startedBy: 'person', ownerId: 'bo', agentSlug: 'release-replace', message: 'Deploy the build.', runId: 'release-p1-b2~s1', inputs: { ownerId: 'bo', projectId: 'p1', pipelineRunId: 'b2' }, bound: { projectId: 'p1' } }]);
    });

    it('deploys nothing for a project that does not deploy its builds', async () => {
      const { releases, started } = await setup(await make());
      expect(await releases.release({ ...project, autoDeployOnBuild: false }, run)).toBe('not-auto-deployed');
      expect(started).toEqual([]);
    });

    it('refuses a project with no owner, saying so on the build', async () => {
      const { releases, started, stored } = await setup(await make());
      const { ownerId: _owner, ...ownerless } = project;
      expect(await releases.release(ownerless as ProjectMetadata, run)).toEqual({ refused: 'the project has no owner' });
      expect(await stored()).toMatchObject({ id: 'b2', commitSha: 'def', releaseRefused: 'the project has no owner' });
      expect(started).toEqual([]);
    });

    it('skips a build that changed nothing the app is built from since the one deployed, and says why on the build', async () => {
      const { releases, started, stored } = await setup(await make(), { decide: async (_p, since, commit) => ({ release: false, reason: `only docs changed between ${since} and ${commit}` }) }, 'abc');
      expect(await releases.release(project, run)).toEqual({ skipped: 'only docs changed between abc and def' });
      expect(await stored()).toMatchObject({ id: 'b2', commitSha: 'def', releaseSkipped: 'only docs changed between abc and def' });
      expect(started).toEqual([]);
    });

    it('waits for a secret only the person can enter, saying which on the build', async () => {
      const { releases, started, stored } = await setup(await make(), { ensureSecrets: async () => ({ waiting: ['STRIPE_KEY'] }) });
      expect(await releases.release(project, run)).toEqual({ refused: 'waiting for the person to enter STRIPE_KEY' });
      expect(await stored()).toMatchObject({ id: 'b2', commitSha: 'def', releaseRefused: 'waiting for the person to enter STRIPE_KEY' });
      expect(started).toEqual([]);
    });
  });
}
