import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { TemporalBridge } from './TemporalBridge.js';
import type { ProjectMetadata, PipelineRunMetadata } from '../lib/types.js';

describe('TemporalBridge.promoteProjectBuild', () => {
  let db: MemoryDB;
  let bridge: TemporalBridge;

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
    bridge = new TemporalBridge(db);
  });

  it('stamps the originating run with promotedAt and deploymentId after a successful deploy', async () => {
    vi.spyOn(bridge, 'deployApp').mockResolvedValue({ id: 'wf-1', resourceId: 'demo', event: 'app-deploy' });

    await bridge.promoteProjectBuild(project, run);

    const [saved] = (await db.getPipelineRuns()).filter((r) => r.id === 'run-1');
    expect(saved?.deploymentId).toBe('demo');
    expect(saved?.promotedAt).toBeTruthy();
  });

  it('leaves the run unstamped when deployApp does not return a resourceId', async () => {
    vi.spyOn(bridge, 'deployApp').mockResolvedValue({ id: 'wf-1', event: 'app-deploy' });

    await bridge.promoteProjectBuild(project, run);

    const [saved] = (await db.getPipelineRuns()).filter((r) => r.id === 'run-1');
    expect(saved?.deploymentId).toBeUndefined();
    expect(saved?.promotedAt).toBeUndefined();
  });
});
