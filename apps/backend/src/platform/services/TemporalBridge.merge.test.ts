import { describe, it, expect, beforeEach, vi } from 'vitest';
import { testDatabase } from '../lib/test-database.js';
import type { MongoDB } from '../lib/mongo-db.js';
import { TemporalBridge } from '../../infrastructure/services/TemporalBridge.js';
import { PALWORLD_SCHEMA } from '../../infrastructure/lib/palworld-settings.js';
import { resolveAppSettings } from '../../infrastructure/lib/app-settings-schema.js';
import type { DeploymentMetadata } from '../lib/types.js';

describe('TemporalBridge.updateConfigAndSync map merging', () => {
  let db: MongoDB;
  let bridge: TemporalBridge;

  const fullSettings = resolveAppSettings(PALWORLD_SCHEMA, { EXP_RATE: '2.0', IS_PVP: 'true' });

  beforeEach(async () => {
    db = await testDatabase();
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
    vi.spyOn(bridge as any, 'syncConfig').mockResolvedValue({ id: 'wf', event: 'app-sync-config' });
  });

  it('merges a partial appSettings patch instead of replacing the map', async () => {
    const before = Object.keys(fullSettings).length;
    expect(before).toBeGreaterThan(100);

    await bridge.updateConfigAndSync('dep-1', { appSettings: { DIFFICULTY: 'Hard' } });

    const [saved] = await db.getDeployments();
    expect(Object.keys(saved!.appSettings!).length).toBe(before + 0);
    expect(saved!.appSettings!.DIFFICULTY).toBe('Hard');
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
