import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { TemporalBridge } from './TemporalBridge.js';
import { PALWORLD_SCHEMA } from '../lib/palworld-settings.js';
import { resolveAppSettings } from '../lib/app-settings-schema.js';
import type { DeploymentMetadata } from '../lib/types.js';

/**
 * The single highest-risk behaviour in the schema-driven-settings design.
 *
 * The Config tab PATCHes only the settings the user actually changed. updateConfigAndSync
 * previously deep-merged `storage` and nothing else, so a partial `appSettings` patch would
 * replace the whole ~120-key map — and the CDKTF re-apply that follows would then revert the
 * running server to defaults. These tests pin the merge so that cannot regress silently.
 */
describe('TemporalBridge.updateConfigAndSync map merging', () => {
  let db: MemoryDB;
  let bridge: TemporalBridge;

  const fullSettings = resolveAppSettings(PALWORLD_SCHEMA, { EXP_RATE: '2.0', IS_PVP: 'true' });

  beforeEach(async () => {
    db = new MemoryDB();
    await db.init();
    await db.saveDeployment({
      id: 'dep-1',
      name: 'my-server',
      clusterId: 'cluster-1',
      strategy: 'native',
      status: 'running',
      appType: 'palworld',
      appSettings: fullSettings,
      storage: { data: '20Gi' },
      ownerId: 'user-1',
    } as DeploymentMetadata);

    bridge = new TemporalBridge(db);
    // syncConfig needs a live Temporal client; the merge happens before it, so stub it out and
    // assert on what landed in the DB.
    vi.spyOn(bridge as any, 'syncConfig').mockResolvedValue({ id: 'wf', event: 'app-sync-config' });
  });

  it('merges a partial appSettings patch instead of replacing the map', async () => {
    const before = Object.keys(fullSettings).length;
    expect(before).toBeGreaterThan(100);

    await bridge.updateConfigAndSync('dep-1', { appSettings: { DIFFICULTY: 'Hard' } });

    const [saved] = await db.getDeployments();
    expect(Object.keys(saved!.appSettings!).length).toBe(before + 0);
    expect(saved!.appSettings!.DIFFICULTY).toBe('Hard');
    // The other ~119 survive — including the user's earlier customisations.
    expect(saved!.appSettings!.EXP_RATE).toBe('2.0');
    expect(saved!.appSettings!.IS_PVP).toBe('true');
    expect(saved!.appSettings!.PAL_CAPTURE_RATE).toBe('1.000000');
  });

  it('still deep-merges storage', async () => {
    await bridge.updateConfigAndSync('dep-1', { storage: { extra: '5Gi' } });
    const [saved] = await db.getDeployments();
    expect(saved!.storage).toEqual({ data: '20Gi', extra: '5Gi' });
  });

  it('leaves appSettings untouched when the patch does not mention it', async () => {
    await bridge.updateConfigAndSync('dep-1', { webTag: 'v2' });
    const [saved] = await db.getDeployments();
    expect(saved!.webTag).toBe('v2');
    expect(Object.keys(saved!.appSettings!).length).toBe(Object.keys(fullSettings).length);
  });

  it('overwrites non-map fields wholesale', async () => {
    await bridge.updateConfigAndSync('dep-1', { webRepo: 'someone/else' });
    const [saved] = await db.getDeployments();
    expect(saved!.webRepo).toBe('someone/else');
  });
});
