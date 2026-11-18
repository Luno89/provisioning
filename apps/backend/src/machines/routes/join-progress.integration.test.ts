import axios from 'axios';
import { Router } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { JOIN_PROGRESS, JOIN_PROGRESS_PATH } from '@koala/engine-core/machine-join';
import { progressCredential } from '@koala/engine-core/machine-progress';
import { machineProgressContract } from '@koala/engine-core/testing/machine-progress';
import { anyOf } from '../../platform/lib/test-matchers.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { MachineAccounts } from '../services/MachineAccounts.js';
import { machinesRouter } from './machines.js';
import { myMachinesRouter } from './my-machines.js';

const sites: Harness[] = [];
afterEach(async () => { for (const site of sites.splice(0)) await site.close(); });

async function root(): Promise<{ site: Harness; accounts: MachineAccounts; told: string[] }> {
  let accounts: MachineAccounts | undefined;
  const told: string[] = [];
  const site = await mountRouter({
    prefix: '/api',
    db: 'own',
    open: true,
    router: (db) => {
      accounts = new MachineAccounts({
        store: db.machines, signing: identityKeysFrom(generateIdentityKey()), settings: { url: 'http://root.test', meshLoginServer: 'https://mesh.test' },
        mesh: { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined },
        koala: { of: async () => undefined }, followers: { joined: async () => undefined, removed: async () => undefined, changed: async () => undefined },
        toMachines: { removed: () => false, koala: () => false, online: () => false },
        toOwner: { machinesChanged: (ownerId) => { told.push(ownerId); } },
      });
      return Router()
        .use('/machines', machinesRouter({ accounts, bundle: { path: async () => '/nowhere', sha256: async () => 'ab'.repeat(32) } }))
        .use('/my-machines', myMachinesRouter({ accounts, koalaOf: async () => undefined }));
    },
  });
  sites.push(site);
  return { site, accounts: accounts!, told };
}

const report = (site: Harness, code: string | undefined, body: unknown) =>
  axios.post(site.url(JOIN_PROGRESS_PATH), body, { headers: { 'content-type': 'application/json', ...(code === undefined ? {} : progressCredential(code)) }, validateStatus: () => true, transformRequest: [(data: unknown) => JSON.stringify(data)] });

const codeFor = async (site: Harness): Promise<string> => ((await axios.post(site.url('/api/my-machines/join-code'), {})).data as { code: string }).code;

machineProgressContract('root\'s join route', JOIN_PROGRESS, async () => {
  const { site } = await root();
  return { credential: () => codeFor(site), post: async (code, body) => (await report(site, code, body)).status };
});

describe('a joining machine reporting its progress to root', () => {
  it('shows the owner each stage as it comes, before and after the machine joined, and a failure until it is dismissed', async () => {
    const { site, accounts, told } = await root();
    const code = await codeFor(site);
    expect((await report(site, code, { stage: 'node', title: 'Node.js of Koala\'s own', state: 'done' })).status).toBe(204);
    expect(told).toEqual([TEST_USER.id]);
    const joined = await accounts.join(code, { hostname: 'desk', rootDir: '/home/me/koala' });
    if (!joined.ok) throw new Error(joined.error);
    expect((await report(site, code, { stage: 'k3s', title: 'Installing k3s', state: 'failed', why: 'no space left on /var' })).status).toBe(204);
    const view = (await axios.get(site.url('/api/my-machines'))).data as { machines: Array<{ id: string }>; joins: Array<{ id: string }> };
    expect(view.machines.map((machine) => machine.id)).toEqual([joined.value.deviceId]);
    expect(view.joins).toEqual([{ id: anyOf(String), stage: 'k3s', title: 'Installing k3s', state: 'failed', why: 'no space left on /var', at: anyOf(String), expiresAt: anyOf(String), joined: true }]);
    expect((await axios.delete(site.url(`/api/my-machines/joins/${view.joins[0]!.id}`))).data).toEqual({ dismissed: true });
    expect(((await axios.get(site.url('/api/my-machines'))).data as { joins: unknown[] }).joins).toEqual([]);
    const after = await report(site, code, { stage: 'k3s', title: 'Installing k3s', state: 'started' });
    expect(after.status).toBe(401);
    expect(after.data).toBe('that command has expired, or its join has finished or was dismissed: make a new one on My Machines');
  });

  it('refuses a report without the join code, or with one root never gave', async () => {
    const { site, told } = await root();
    expect((await report(site, undefined, { stage: 'k3s', title: 'Installing k3s', state: 'started' })).status).toBe(401);
    expect((await report(site, 'made-up', { stage: 'k3s', title: 'Installing k3s', state: 'started' })).status).toBe(401);
    expect(told).toEqual([]);
  });
});
