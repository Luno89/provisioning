import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { deployProjectBuild, type AppDeployDeps } from '../../infrastructure/services/AppDeploy.js';
import type { ClusterMetadata, ProjectMetadata, PipelineRunMetadata } from '../lib/types.js';

describe('deploying a project\'s build', () => {
  let db: MemoryDB;
  let starts: { workflowId: string; taskQueue: string; args: unknown[] }[];
  let deps: AppDeployDeps;

  const project: ProjectMetadata = {
    id: 'proj-1',
    name: 'demo',
    giteaOwner: 'acme',
    giteaRepo: 'demo',
    appType: 'gitapp',
    targetClusterId: 'cluster-1',
    createdAt: '2026-01-01T00:00:00Z',
  };

  const run: PipelineRunMetadata = {
    id: 'run-1',
    projectId: 'proj-1',
    commitSha: 'abc123',
    ref: 'main',
    status: 'succeeded',
    imageTag: 'registry.local/demo:abc123',
    startedAt: '2026-01-01T00:00:00Z',
  };

  beforeEach(async () => {
    db = new MemoryDB();
    await db.init();
    await db.savePipelineRunInfo(run);
    starts = [];
    deps = {
      db,
      client: () => ({ workflow: { start: async (_type: unknown, options: { workflowId: string; taskQueue: string; args: unknown[] }) => { starts.push(options); return { workflowId: options.workflowId }; } } }) as never,
      masterKey: 'k',
      clusterById: async (id) => (id === 'cluster-1' ? { id, name: 'dev', provider: 'k3d' } as ClusterMetadata : undefined),
      logDir: '/tmp',
    };
  });

  it('starts the app deploy with the build\'s image, records the deployment deploying, and stamps the build with it', async () => {
    const started = await deployProjectBuild(deps, project, run);

    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ workflowId: started.workflowId, taskQueue: 'cluster-ops-queue' });
    expect(starts[0]!.args[0]).toMatchObject({ name: 'demo', clusterName: 'dev', appType: 'gitapp', odooRepo: 'registry.local/demo', odooTag: 'abc123' });
    expect((await db.getDeployments())[0]).toMatchObject({ id: 'demo', status: 'deploying', gitappProjectId: 'proj-1', gitappImageTag: 'registry.local/demo:abc123', temporalWorkflowId: started.workflowId });
    const [saved] = (await db.getPipelineRuns()).filter((entry) => entry.id === 'run-1');
    expect(saved).toMatchObject({ deploymentId: 'demo', promotedAt: expect.any(String) });
  });

  it('deploys a build as the project\'s owner, so the person can see and remove the app it makes', async () => {
    await deployProjectBuild(deps, { ...project, ownerId: 'owner-7' }, run);
    expect((await db.getDeployments())[0]!.ownerId).toBe('owner-7');
  });

  it('deploys nothing for a build with no image, and leaves the build unstamped', async () => {
    await expect(deployProjectBuild(deps, project, { ...run, imageTag: undefined } as never)).rejects.toThrow('Pipeline run has no built image to promote');
    expect(starts).toEqual([]);
    expect((await db.getPipelineRuns())[0]!.promotedAt).toBeUndefined();
  });
});
