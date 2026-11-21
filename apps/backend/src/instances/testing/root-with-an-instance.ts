import type { NextFunction, Request, Response } from 'express';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { instancesRouter } from '../routes/instances.js';
import { InstanceService } from '../services/InstanceService.js';
import type { InstanceRecord } from '../lib/instances.js';
import { koalaPlacedAndUp, testInstanceClients } from './placed-koala.js';

export interface RootWithAnInstance {
  harness: Harness;
  instance: { rootUrl: string; instanceId: string; token: () => Promise<string> };
  meshAsked: string[];
  record: () => Promise<InstanceRecord>;
  close: () => Promise<void>;
}

export async function rootWithAnInstance(): Promise<RootWithAnInstance> {
  let service: InstanceService | undefined;
  const meshAsked: string[] = [];
  const settings = {
    rootUrl: '', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 'new222', domain: 'koala.dev', meshLoginServer: 'https://mesh.koala.dev', ...testInstanceClients,
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
      });
      return instancesRouter({ instances: service, chart: async () => '', operatorOnly: (_req: Request, _res: Response, next: NextFunction) => next() });
    },
  });
  settings.rootUrl = harness.url('');
  const joined = { value: await koalaPlacedAndUp(service!, harness.db, TEST_USER.id, { id: 'box', name: 'box', meshIp: '100.64.0.9' }, 'luno') };
  await service!.report(joined.value.instanceId, joined.value.token, { status: 'ready', detail: 'Installed', imageTag: 'old111', meshIp: '100.64.0.9', presence: true });
  const instance = { rootUrl: harness.url(''), instanceId: joined.value.instanceId, token: async () => joined.value.token };
  return { harness, instance, meshAsked, record: async () => (await harness.db.instances.getInstances()).find((entry) => entry.id === joined.value.instanceId)!, close: () => harness.close() };
}
