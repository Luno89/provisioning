import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess, MoveIn, Reach } from '../infrastructure/index.js';
import { MOVE_IN_ID } from '../infrastructure/index.js';
import { MemoryInfrastructureStore } from '../infrastructure/testing/memory-store.js';
import type { GiteaService } from '../projects/index.js';
import type { ClusterSteps } from './cluster-steps.js';
import { bringMoveOver } from './move-over.js';

const OWN: Reach = { clusterId: 'machine-desk', kind: 'koala' };
const MOVE_IN: MoveIn = { id: MOVE_IN_ID, ownerId: 'bo', from: 'pool-shop', onto: 'machine-desk', at: '2026-11-18T10:00:00.000Z' };
const MANIFEST = {
  pullHost: '10.0.0.1:5000',
  namespaces: [{
    namespace: 'shop',
    labels: { 'koala.app/owner': 'bo' },
    objects: [
      { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'data', namespace: 'shop' }, spec: {} },
      { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'shop', namespace: 'shop' }, spec: {} },
    ],
    volumes: [{ claim: 'data' }],
  }],
};

const ready = (name: string) => JSON.stringify({ kind: 'Pod', metadata: { name }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } });

function world(pod: (name: string) => string = ready) {
  const access = mock<ClusterAccess>();
  access.own.mockReturnValue(OWN);
  const ran: string[] = [];
  access.kubectl.mockImplementation(async (_reach, args) => {
    ran.push(args.join(' '));
    if (args[0] === 'get' && args[1] === 'pods') return '';
    if (args[0] === 'get' && args[1] === 'pod') return pod(args[2]!);
    if (args[0] === 'get' && args[1] === 'deployment') return '1';
    if (args[0] === 'get') return JSON.stringify({ items: [] });
    return '';
  });
  access.pipe.mockImplementation(async (_reach, args) => { ran.push(`${args.join(' ')} <`); return ''; });
  const gitea = mock<GiteaService>();
  gitea.getRegistryHost.mockResolvedValue('127.0.0.1:31737');
  const steps = mock<ClusterSteps>({ access, gitea });
  const asked: string[] = [];
  const said: string[] = [];
  const records = new MemoryInfrastructureStore();
  const parts = (say: (line: string) => void) => ({
    async part(name: string) {
      asked.push(name);
      say(`asking for ${name}`);
      return Readable.from([name === 'apps' ? JSON.stringify(MANIFEST) : name]);
    },
  }) as never;
  const deps = { steps, parts, records, now: () => '2026-11-18T11:00:00.000Z', wait: { pause: async () => undefined }, pause: async () => undefined };
  return { deps, ran, asked, said, records, report: (line: string) => said.push(line) };
}

describe('bringing over what a move left, once Koala\'s services are up', () => {
  it('restores Gitea\'s database and data, then Infisical\'s database, then the apps with their volumes, and records the move brought over', async () => {
    const { deps, asked, ran, said, records, report } = world();
    await records.saveMoveIn(MOVE_IN);
    await bringMoveOver(deps, report);

    expect(asked).toEqual(['gitea-db', 'gitea-data', 'infisical-db', 'apps', 'volume:shop:data']);
    expect(said).toContain('shop: 2 objects, 1 volumes');
    expect(ran.indexOf('scale deployment/gitea -n gitea --replicas=0')).toBeLessThan(ran.findIndex((line) => line.startsWith('exec -i -n gitea gitea-postgresql-0')));
    expect(ran).toContain('scale deployment/gitea -n gitea --replicas=1');
    expect(ran.some((line) => line.includes('--timeout'))).toBe(false);
    expect(await records.getMoveIn()).toEqual({ ...MOVE_IN, broughtAt: '2026-11-18T11:00:00.000Z' });
  });

  it('brings nothing over again once the move has been brought over', async () => {
    const { deps, asked, ran, records, report } = world();
    await records.saveMoveIn({ ...MOVE_IN, broughtAt: '2026-11-18T10:30:00.000Z' });
    await bringMoveOver(deps, report);
    expect(asked).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('fails with why on a Koala nothing was moved onto', async () => {
    const { deps, report } = world();
    await expect(bringMoveOver(deps, report)).rejects.toThrow('nothing was moved onto this Koala, so there is nothing to bring over');
  });

  it('fails with why when a pod it copies through can never start, and records nothing brought over', async () => {
    const stuck = (name: string) => JSON.stringify({ kind: 'Pod', metadata: { name }, status: { phase: 'Pending', containerStatuses: [{ name, ready: false, state: { waiting: { reason: 'ImagePullBackOff', message: 'busybox:1.37 could not be pulled' } } }] } });
    const { deps, records, report } = world(stuck);
    await records.saveMoveIn(MOVE_IN);
    await expect(bringMoveOver(deps, report)).rejects.toThrow(/gitea-postgresql-0 in gitea to be ready: .*ImagePullBackOff/);
    expect(await records.getMoveIn()).toEqual(MOVE_IN);
  });
});
