import type { NextFunction, Request, Response } from 'express';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { instancesRouter } from '../routes/instances.js';
import { InstanceService } from '../services/InstanceService.js';
import type { InstanceRecord } from '../lib/instances.js';

export interface RootWithAnInstance {
  harness: Harness;
  instance: { rootUrl: string; instanceId: string; token: () => Promise<string> };
  meshAsked: string[];
  poolAsked: string[];
  record: () => Promise<InstanceRecord>;
  close: () => Promise<void>;
}

export async function rootWithAnInstance(options: { pool?: boolean } = {}): Promise<RootWithAnInstance> {
  let service: InstanceService | undefined;
  const meshAsked: string[] = [];
  const poolAsked: string[] = [];
  const settings = {
    rootUrl: '', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 'new222', domain: 'koala.dev', meshLoginServer: 'https://mesh.koala.dev',
    releases: { hasChart: () => false, releases: async () => [
      { imageTag: 'old111', version: 'v2026.10.29', servedAt: '2026-10-29T00:00:00Z' },
      { imageTag: 'new222', version: 'v2026.10.30', servedAt: '2026-10-30T00:00:00Z' },
    ] },
  };
  const harness = await mountRouter({
    db: 'own',
    prefix: '/api/instances',
    router: (db) => {
      service = new InstanceService(db, settings, {
        createPreAuthKey: async (ownerId) => { meshAsked.push(`key for ${ownerId}`); return { key: `key-of-${ownerId}` }; },
        listUserDevices: async () => [{ ipAddresses: ['100.64.0.9'] }],
        removeNode: async (ownerId, meshIp) => { meshAsked.push(`remove ${meshIp} of ${ownerId}`); },
      }, undefined, undefined, {
        start: async () => undefined,
        trialChanged: async () => undefined,
        remove: async () => undefined,
        move: async (instanceId) => { poolAsked.push(`move ${instanceId}`); },
        moveStopped: async (instanceId, reason) => { poolAsked.push(`stop ${instanceId}: ${reason}`); },
      });
      return instancesRouter({ instances: service, chart: async () => '', operatorOnly: (_req: Request, _res: Response, next: NextFunction) => next() });
    },
  });
  settings.rootUrl = harness.url('');
  const made = await service!.createJoinToken(TEST_USER.id, 'luno');
  if (!made.ok) throw new Error(made.error);
  const joined = await service!.join(made.value.token, 'box');
  if (!joined.ok) throw new Error(joined.error);
  await service!.report(joined.value.instanceId, joined.value.credential, { status: 'ready', detail: 'Installed', imageTag: 'old111', meshIp: '100.64.0.9', presence: true });
  if (options.pool) {
    const joinedInstance = (await harness.db.instances.getInstances()).find((entry) => entry.id === joined.value.instanceId)!;
    await harness.db.instances.saveInstance({ ...joinedInstance, pool: { ports: { backend: 1, edge: 2, registry: 3 }, startedAt: '2026-10-30T00:00:00Z', trialEndsAt: '2026-11-30T00:00:00Z' } });
  }
  const instance = { rootUrl: harness.url(''), instanceId: joined.value.instanceId, token: async () => joined.value.credential };
  return { harness, instance, meshAsked, poolAsked, record: async () => (await harness.db.instances.getInstances()).find((entry) => entry.id === joined.value.instanceId)!, close: () => harness.close() };
}
