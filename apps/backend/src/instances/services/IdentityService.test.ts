import { describe, it, expect, beforeEach } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { IdentityService } from './IdentityService.js';
import { generateIdentityKey, identityKeysFrom, issueHandoff, publicKeyPem, trustedKeys } from '../lib/identity-token.js';
import type { RoleConfig } from '../../platform/lib/platform-role.js';

const signing = identityKeysFrom(generateIdentityKey());
const rootRole: RoleConfig = { role: 'root', signing };
const instanceRole = (ownerId = 'u1', id = 'inst-u1'): RoleConfig => ({
  role: 'instance',
  trusted: trustedKeys([publicKeyPem(signing.publicKey)]),
  instance: { id, ownerId, rootUrl: 'https://app.example.com' },
});

let rootDb: MongoDB;
let instanceDb: MongoDB;
let now: number;

beforeEach(async () => {
  rootDb = await testDatabase();
  instanceDb = await testDatabase();
  now = 1_800_000_000;
});

describe('signing in at root and landing on your own instance', () => {
  it('hands a user from root to the instance they own, which signs them in as its owner', async () => {
    const root = new IdentityService(rootRole, rootDb, () => now);
    expect(await root.register({ id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com/' })).toMatchObject({ ok: true });

    const url = await root.handoffUrl({ id: 'u1', email: 'u1@example.com' });
    expect(url).toMatch(/^https:\/\/u1\.example\.com\/#\/handoff\?token=/);
    const token = decodeURIComponent(url!.split('token=')[1]!);

    const instance = new IdentityService(instanceRole(), instanceDb, () => now + 3);
    expect(await instance.acceptHandoff(token)).toEqual({ ok: true, user: { id: 'u1', email: 'u1@example.com' } });
    expect(await instanceDb.accounts.getUserById('u1')).toMatchObject({ email: 'u1@example.com', isAdmin: true, emailVerified: true });
  });

  it('refuses the same token twice', async () => {
    const instance = new IdentityService(instanceRole(), instanceDb, () => now);
    const token = issueHandoff(signing, { userId: 'u1', email: 'u1@example.com' }, 'inst-u1', now);

    expect((await instance.acceptHandoff(token)).ok).toBe(true);
    expect(await instance.acceptHandoff(token)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/already been used/) });
  });

  it('lets no one in but its owner, even with a token root really signed', async () => {
    const instance = new IdentityService(instanceRole('u1'), instanceDb, () => now);
    const forSomeoneElse = issueHandoff(signing, { userId: 'u2', email: 'u2@example.com' }, 'inst-u1', now);

    expect(await instance.acceptHandoff(forSomeoneElse)).toMatchObject({ ok: false, status: 403 });
    expect(await instanceDb.accounts.getUserById('u2')).toBeUndefined();
  });

  it('refuses a token meant for another instance, or one that has expired', async () => {
    const instance = new IdentityService(instanceRole(), instanceDb, () => now + 61);
    expect(await instance.acceptHandoff(issueHandoff(signing, { userId: 'u1', email: 'e' }, 'inst-other', now))).toMatchObject({ status: 401, error: expect.stringMatching(/different instance/) });
    expect(await instance.acceptHandoff(issueHandoff(signing, { userId: 'u1', email: 'e' }, 'inst-u1', now))).toMatchObject({ status: 401, error: expect.stringMatching(/expired/) });
  });

  it('issues nothing for a user with no instance, and takes no tokens when it is not an instance', async () => {
    const root = new IdentityService(rootRole, rootDb, () => now);
    expect(await root.handoffUrl({ id: 'nobody', email: 'n@example.com' })).toBeUndefined();
    expect(await root.acceptHandoff('anything')).toMatchObject({ ok: false, status: 400 });
  });

  it('sends no one to an instance that is still being set up', async () => {
    const root = new IdentityService(rootRole, rootDb, () => now);
    await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: '', createdAt: 'x', updatedAt: 'x', status: 'waiting' });
    expect(await root.handoffUrl({ id: 'u1', email: 'e' })).toBeUndefined();
    await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: 'http://100.64.0.7:30320', createdAt: 'x', updatedAt: 'x', status: 'installing' });
    expect(await root.handoffUrl({ id: 'u1', email: 'e' })).toBeUndefined();
    await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: 'http://100.64.0.7:30320', createdAt: 'x', updatedAt: 'x', status: 'ready' });
    expect(await root.handoffUrl({ id: 'u1', email: 'e' })).toMatch(/^http:\/\/100\.64\.0\.7:30320\/#\/handoff/);
  });

  it('keeps sending its owner to an instance while it upgrades itself and after it rolls a failed upgrade back', async () => {
    const root = new IdentityService(rootRole, rootDb, () => now);
    await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: 'http://100.64.0.7:30320', createdAt: 'x', updatedAt: '2026-10-23T01:00:00.000Z', status: 'ready' });
    const stored = (await rootDb.instances.getInstances('u1'))[0]!;
    expect(stored.servedAt).toBe('2026-10-23T01:00:00.000Z');
    await rootDb.instances.saveInstance({ ...stored, status: 'installing', detail: 'Upgrading from a to b', updatedAt: '2026-10-24T01:00:00.000Z' });
    expect(await root.handoffUrl({ id: 'u1', email: 'e' })).toMatch(/^http:\/\/100\.64\.0\.7:30320\/#\/handoff/);
    await rootDb.instances.saveInstance({ ...stored, status: 'failed', detail: 'The upgrade to b failed, so it was rolled back to a', updatedAt: '2026-10-24T02:00:00.000Z' });
    expect(await root.handoffUrl({ id: 'u1', email: 'e' })).toMatch(/^http:\/\/100\.64\.0\.7:30320\/#\/handoff/);
    expect((await rootDb.instances.getInstances('u1'))[0]!.servedAt).toBe('2026-10-23T01:00:00.000Z');
  });

  it('registers one instance per user, at an origin', async () => {
    const root = new IdentityService(rootRole, rootDb, () => now);
    expect(await root.register({ id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com/app' })).toMatchObject({ ok: false, error: expect.stringMatching(/origin/) });
    expect((await root.register({ id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com' })).ok).toBe(true);
    expect(await root.register({ id: 'inst-u1-b', ownerId: 'u1', url: 'https://b.example.com' })).toMatchObject({ ok: false, error: expect.stringMatching(/already has an instance/) });
  });
});

describe('signing in at root and landing on the hub', () => {
  const hubRole: RoleConfig = { role: 'hub', trusted: trustedKeys([publicKeyPem(signing.publicKey)]), hub: { rootUrl: 'https://app.example.com', credential: 'c' } };
  const linkedRoot: RoleConfig = { role: 'root', signing, hubLink: { url: 'https://hub.example.com', credentialHash: 'h' } };

  it('hands anyone root signs in to the hub, where they are a person and not an admin, and carries where they were going', async () => {
    const root = new IdentityService(linkedRoot, rootDb, () => now);
    const url = await root.handoffUrl({ id: 'u7', email: 'cy@example.com' }, { hub: true, next: '/hub/join/abc' });
    expect(url).toMatch(/^https:\/\/hub\.example\.com\/#\/handoff\?token=[^&]+&next=%2Fhub%2Fjoin%2Fabc$/);
    const token = decodeURIComponent(/token=([^&]+)/.exec(url!)![1]!);

    const hub = new IdentityService(hubRole, instanceDb, () => now);
    expect(await hub.acceptHandoff(token)).toEqual({ ok: true, user: { id: 'u7', email: 'cy@example.com' } });
    expect(await instanceDb.accounts.getUserById('u7')).toMatchObject({ email: 'cy@example.com', isAdmin: false });
    expect(await hub.acceptHandoff(token)).toMatchObject({ ok: false, status: 409 });
    expect(hub.signInUrl()).toBe('https://app.example.com/api/identity/go?to=hub');
  });

  it('refuses a token root signed for an instance, sends nowhere a path that leaves the hub, and has no hub to send to without one', async () => {
    const hub = new IdentityService(hubRole, instanceDb, () => now);
    expect(await hub.acceptHandoff(issueHandoff(signing, { userId: 'u1', email: 'a@example.com' }, 'inst-u1', now))).toMatchObject({ ok: false, status: 401 });
    const root = new IdentityService(linkedRoot, rootDb, () => now);
    expect(await root.handoffUrl({ id: 'u7', email: 'cy@example.com' }, { hub: true, next: '//evil.example.com' })).not.toContain('next=');
    expect(await new IdentityService(rootRole, rootDb, () => now).handoffUrl({ id: 'u7', email: 'cy@example.com' }, { hub: true })).toBeUndefined();
  });
});
