import { afterEach, describe, expect, it } from 'vitest';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { RootMachines } from '../../instances/services/RootMachines.js';
import { MachineAccounts, type AccountMachine } from '../services/MachineAccounts.js';
import { accountMachinesRouter } from './account-machines.js';

const sites: Harness[] = [];
afterEach(async () => { await Promise.all(sites.splice(0).map((site) => site.close())); });

async function root() {
  let accounts: MachineAccounts | undefined;
  const removed: AccountMachine[] = [];
  const told: Array<[string, string]> = [];
  const site = await mountRouter({
    prefix: '/api/instances/machines',
    user: null,
    open: true,
    db: 'own',
    router: (db) => {
      accounts = new MachineAccounts({
        store: db.machines,
        signing: identityKeysFrom(generateIdentityKey()),
        settings: { url: 'https://app.koala.example', meshLoginServer: 'https://mesh.koala.example' },
        mesh: { createPreAuthKey: async () => ({ key: 'preauth-key' }), removeNode: async () => undefined },
        koala: { of: async () => ({ url: 'https://bo.people.example', audience: 'inst-1' }) },
        followers: { joined: async () => undefined, removed: async (machine) => { removed.push(machine); }, changed: async () => undefined },
        toOwner: { machinesChanged: () => undefined },
        toMachines: { removed: (deviceId) => { told.push([deviceId, 'machine:removed']); return true; }, koala: () => true },
      });
      return accountMachinesRouter({
        accounts,
        callerOf: async (req) => (req.headers['x-instance-id'] === 'inst-1' && req.headers.authorization === 'Bearer right' ? { ownerId: 'bo' } : undefined),
      });
    },
  });
  sites.push(site);
  const client = (token = 'right') => new RootMachines({ rootUrl: site.url(''), instanceId: 'inst-1', token: async () => token });
  return { accounts: accounts!, client, removed, told };
}

describe('an instance\'s machine client against root\'s own routes', () => {
  it('makes a command at root, sees the machine that joined with it, and removes it', async () => {
    const { accounts, client, removed, told } = await root();
    const made = await client().createJoinCode('bo');
    expect(made.command).toBe(`curl -fsSL https://app.koala.example/machine.sh | sh -s -- ${made.code}`);
    const joined = await accounts.join(made.code, { hostname: 'desk', rootDir: '/home/bo/koala' });
    if (!joined.ok) throw new Error(joined.error);
    const listed = await client().list();
    expect(listed).toEqual([expect.objectContaining({ id: joined.value.deviceId, ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala' })]);
    expect(JSON.stringify(listed)).not.toContain('tokenHash');
    expect(await client().remove('bo', joined.value.deviceId)).toBe(true);
    expect(await client().list()).toEqual([]);
    expect(removed.map((machine) => machine.id)).toEqual([joined.value.deviceId]);
    expect(told).toEqual([[joined.value.deviceId, 'machine:removed']]);
  });

  it('takes the instance\'s machines from before as its owner\'s, once', async () => {
    const { accounts, client } = await root();
    const machine = { id: 'old', ownerId: 'whoever', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-10-01T00:00:00Z', tokenHash: 'h'.repeat(64) };
    expect(await client().adopt([machine])).toEqual({ adopted: 1 });
    expect(await client().adopt([machine])).toEqual({ adopted: 0 });
    expect(await accounts.list('bo')).toEqual([expect.objectContaining({ id: 'old', ownerId: 'bo' })]);
    await expect(client('wrong').adopt([machine])).rejects.toThrow('(401)');
  });

  it('shows an instance only its owner\'s machines, removes no one else\'s, and refuses a caller it does not know', async () => {
    const { accounts, client } = await root();
    const theirs = await accounts.join((await accounts.createJoinCode('cy')).code, { hostname: 'other', rootDir: '/x' });
    if (!theirs.ok) throw new Error(theirs.error);
    expect(await client().list()).toEqual([]);
    expect(await client().remove('bo', theirs.value.deviceId)).toBe(false);
    expect(await accounts.list('cy')).toHaveLength(1);
    await expect(client('wrong').list()).rejects.toThrow('(401): unknown instance or credential');
    await expect(client('wrong').createJoinCode('bo')).rejects.toThrow('(401)');
  });
});
