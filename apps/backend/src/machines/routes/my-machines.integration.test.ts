import { testKeys } from '../../platform/testing/keys.js';
import axios from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { InstanceService } from '../../instances/services/InstanceService.js';
import { MachineAccounts } from '../services/MachineAccounts.js';
import { myMachinesRouter } from './my-machines.js';

const keys = testKeys('my-machines-test-secret');
const sites: Harness[] = [];
afterEach(async () => { for (const site of sites.splice(0)) await site.close(); });

async function root(): Promise<{ site: Harness; accounts: MachineAccounts }> {
  let accounts: MachineAccounts | undefined;
  const site = await mountRouter({
    prefix: '/api/my-machines',
    db: 'own',
    router: (db) => {
      const instances = new InstanceService(db, { rootUrl: 'http://root.test', rootPublicKeys: () => ['PEM'], meshLoginServer: 'https://mesh.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '' },
        { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined });
      accounts = new MachineAccounts({
        store: db.machines, dataKey: keys.data, signing: identityKeysFrom(generateIdentityKey()), settings: { url: 'http://root.test' },
        koala: { of: async () => undefined }, followers: { joined: async () => undefined, removed: async () => undefined, changed: async () => undefined },
        toMachines: { removed: () => false, koala: () => false, placeKoala: async () => false, online: () => false },
        placer: instances,
      });
      return myMachinesRouter({ accounts, koalaOf: async (owner) => {
        const instance = (await db.instances.getInstances(owner))[0];
        return instance ? { machineId: instance.machineId, status: instance.status } : undefined;
      } });
    },
  });
  sites.push(site);
  return { site, accounts: accounts! };
}

describe('a person\'s machines on root\'s own page', () => {
  it('adds a machine that asks for their Koala, lists it, and puts Koala on it once it is on the mesh, waiting while it is offline', async () => {
    const { site, accounts } = await root();
    const made = (await axios.post(site.url('/api/my-machines/join-code'), { koalaName: 'bobby' })).data as { code: string; command: string };
    expect(made.command).toBe(`curl -fsSL http://root.test/machine.sh | sh -s -- ${made.code}`);
    const joined = await accounts.join(made.code, { hostname: 'desk', rootDir: '/home/me/koala' });
    if (!joined.ok) throw new Error(joined.error);
    const id = joined.value.deviceId;
    expect((await axios.get(site.url('/api/my-machines'))).data).toEqual({ koala: null, machines: [expect.objectContaining({ id, name: 'desk', online: false, koalaWanted: true, holdsKoala: false })] });
    await accounts.recordMeshIp(id, '100.64.0.7');
    expect((await axios.post(site.url(`/api/my-machines/${id}/koala`), {})).data).toEqual({ placing: false });
    expect((await axios.get(site.url('/api/my-machines'))).data).toMatchObject({ koala: { machineId: id, status: 'joined' }, machines: [{ holdsKoala: true, koalaWanted: true }] });
    expect((await site.db.instances.getInstances(TEST_USER.id))[0]).toMatchObject({ name: 'bobby', machine: 'desk' });
  });

  it('refuses a machine that is not the person\'s', async () => {
    const { site } = await root();
    const answer = await axios.post(site.url('/api/my-machines/nope/koala'), {}, { validateStatus: () => true });
    expect(answer).toMatchObject({ status: 404, data: { error: 'no such machine on your account' } });
  });
});
