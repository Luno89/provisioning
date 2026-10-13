import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { TemporalBridge } from './TemporalBridge.js';
import { buildPlanAt } from '../lib/build-plan.js';
import type { ProjectMetadata } from '../lib/types.js';

const project = { id: 'proj-1', name: 'notes', ownerId: 'u1', giteaOwner: 'acme', giteaRepo: 'notes', appType: 'gitapp', createdAt: 'then' } as ProjectMetadata;

describe('a push to a project', () => {
  let db: MemoryDB;
  let bridge: TemporalBridge;

  beforeEach(async () => {
    db = new MemoryDB();
    await db.init();
    bridge = new TemporalBridge(db);
  });

  it('records no build when the commit has nothing to build', async () => {
    bridge.planBuild = (_project, sha) => buildPlanAt(async () => null, sha);
    expect(await bridge.runPipeline(project, '8c646f4f20f5fb217793c11ebbab0779f7d26757', 'main')).toEqual({ id: '', event: 'nothing-to-build' });
    expect(await db.getPipelineRuns()).toEqual([]);
  });

  it('refuses anything but a commit hash before it records or runs anything', async () => {
    await expect(bridge.runPipeline(project, 'main; reboot', 'main')).rejects.toThrow('"main; reboot" is not a commit to build');
    expect(await db.getPipelineRuns()).toEqual([]);
  });
});
