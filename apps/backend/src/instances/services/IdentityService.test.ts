import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import type { Database } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { IdentityService } from './IdentityService.js';
import { generateIdentityKey, identityKeysFrom } from '../lib/identity-token.js';
import type { RoleConfig } from '../../platform/lib/platform-role.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);

const signing = identityKeysFrom(generateIdentityKey());
const rootRole: RoleConfig = { role: 'root', signing };
const announced = { jwk: { kty: 'OKP' as const, crv: 'Ed25519' as const, x: 'x', kid: 'k' }, since: '2026-10-29T00:00:00.000Z' };

let rootDb: Database;

let now: number;

beforeEach(async () => {
  rootDb = memoryDatabase();
  now = 1_800_000_000;
});

describe('signing in at root and landing on your own instance', () => {
  it('sends a signed-in owner to their instance\'s own sign-in start, never a handoff', async () => {
    const root = new IdentityService(rootRole, rootDb, () => now);
    expect(await root.register({ id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com/' })).toMatchObject({ ok: true });
    await rootDb.instances.saveSignInKey('inst-u1', announced);
    expect(await root.goUrl({ id: 'u1', email: 'u1@example.com' })).toEqual({ url: 'https://u1.example.com/api/auth/oidc/start' });
  });

  it('tells the owner of an instance that has not named its key so, instead of sending them on', async () => {
    const root = new IdentityService(rootRole, rootDb, () => now);
    expect(await root.register({ id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com/' })).toMatchObject({ ok: true });
    expect(await root.goUrl({ id: 'u1', email: 'u1@example.com' })).toEqual({ waiting: 'your Koala has not named its sign-in key to root yet; it does so as it starts' });
  });

  it('issues nothing for a user with no instance', async () => {
    const root = new IdentityService(rootRole, rootDb, () => now);
    expect(await root.goUrl({ id: 'nobody', email: 'n@example.com' })).toBeUndefined();
  });

  it('sends no one to an instance that is still being set up', async () => {
    const root = new IdentityService(rootRole, rootDb, () => now);
    await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: '', createdAt: 'x', updatedAt: 'x', status: 'waiting' });
    expect(await root.goUrl({ id: 'u1', email: 'e' })).toBeUndefined();
    await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: 'http://100.64.0.7:30320', createdAt: 'x', updatedAt: 'x', status: 'installing' });
    expect(await root.goUrl({ id: 'u1', email: 'e' })).toBeUndefined();
    await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: 'http://100.64.0.7:30320', createdAt: 'x', updatedAt: 'x', status: 'ready', signIn: announced });
    expect(await root.goUrl({ id: 'u1', email: 'e' })).toEqual({ url: 'http://100.64.0.7:30320/api/auth/oidc/start' });
  });

  it('keeps sending its owner to an instance while it upgrades itself and after it rolls a failed upgrade back', async () => {
    const root = new IdentityService(rootRole, rootDb, () => now);
    await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: 'http://100.64.0.7:30320', createdAt: 'x', updatedAt: '2026-10-23T01:00:00.000Z', status: 'ready', signIn: announced });
    const stored = (await rootDb.instances.getInstances('u1'))[0]!;
    expect(stored.servedAt).toBe('2026-10-23T01:00:00.000Z');
    await rootDb.instances.saveInstance({ ...stored, status: 'installing', detail: 'Upgrading from a to b', updatedAt: '2026-10-24T01:00:00.000Z' });
    expect(await root.goUrl({ id: 'u1', email: 'e' })).toEqual({ url: 'http://100.64.0.7:30320/api/auth/oidc/start' });
    await rootDb.instances.saveInstance({ ...stored, status: 'failed', detail: 'The upgrade to b failed, so it was rolled back to a', updatedAt: '2026-10-24T02:00:00.000Z' });
    expect(await root.goUrl({ id: 'u1', email: 'e' })).toEqual({ url: 'http://100.64.0.7:30320/api/auth/oidc/start' });
  });

  it('registers one instance per user, at an origin', async () => {
    const root = new IdentityService(rootRole, rootDb, () => now);
    expect(await root.register({ id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com/app' })).toMatchObject({ ok: false, error: matching(/origin/) });
    expect((await root.register({ id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com' })).ok).toBe(true);
    expect(await root.register({ id: 'inst-u1-b', ownerId: 'u1', url: 'https://b.example.com' })).toMatchObject({ ok: false, error: matching(/already has an instance/) });
  });

  it('gives an instance registered by hand a credential to sign people in with, kept only as its hash', async () => {
    const root = new IdentityService(rootRole, rootDb, () => now);
    const first = await root.register({ id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com' });
    if (!first.ok) throw new Error(first.error);
    const stored = (await rootDb.instances.getInstances('u1'))[0]!;
    expect(stored.credentialHash).toBe(crypto.createHash('sha256').update(first.credential).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(first.credential);
    const again = await root.register({ id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com' });
    if (!again.ok) throw new Error(again.error);
    expect(again.credential).not.toBe(first.credential);
    expect((await rootDb.instances.getInstances('u1'))[0]!.credentialHash).toBe(crypto.createHash('sha256').update(again.credential).digest('hex'));
  });
});

describe('signing in at root and landing on the hub', () => {
  const linkedRoot: RoleConfig = { role: 'root', signing, hubLink: { url: 'https://hub.example.com', credentialHash: 'h' } };

  it('sends anyone to the hub\'s own sign-in once the hub names its sign-in key, carrying where they were going, and says the hub is not ready before', async () => {
    const root = new IdentityService(linkedRoot, rootDb, () => now);
    expect(await root.goUrl({ id: 'u7', email: 'cy@example.com' }, { hub: true, next: '/hub/join/abc' })).toEqual({ waiting: 'the hub has not named its sign-in key to root yet; it does so as it starts' });

    await rootDb.instances.saveHubSignInKey(announced);
    expect(await root.goUrl({ id: 'u7', email: 'cy@example.com' }, { hub: true, next: '/hub/join/abc' })).toEqual({ url: 'https://hub.example.com/api/auth/oidc/start?next=%2Fhub%2Fjoin%2Fabc' });
    expect(await root.goUrl({ id: 'u7', email: 'cy@example.com' }, { hub: true, next: '//evil.example.com' })).toEqual({ url: 'https://hub.example.com/api/auth/oidc/start' });
  });

  it('has no hub to send anyone to without one', async () => {
    expect(await new IdentityService(rootRole, rootDb, () => now).goUrl({ id: 'u7', email: 'cy@example.com' }, { hub: true })).toBeUndefined();
  });
});

describe('what root and an instance say about each other', () => {
  it('publishes the key root signs with, and none when it signs nothing', () => {
    expect(new IdentityService(rootRole, rootDb, () => now).publicKeys()).toEqual([{ kid: signing.kid, publicKey: containing('BEGIN PUBLIC KEY') }]);
    expect(new IdentityService({ role: 'instance' } as RoleConfig, rootDb, () => now).publicKeys()).toEqual([]);
  });

  it('hands an instance the addresses at root for the hub and for removing an account', () => {
    const instance = new IdentityService({ role: 'instance', instance: { id: 'inst-u1', ownerId: 'u1', rootUrl: 'https://app.example.com', rootPublicKeys: [] } } as unknown as RoleConfig, rootDb, () => now);
    expect(instance.hubUrl()).toBe('https://app.example.com/api/identity/go?to=hub');
    expect(instance.removalUrl()).toBe('https://app.example.com/#/remove-account');
    expect(new IdentityService(rootRole, rootDb, () => now).hubUrl()).toBeUndefined();
    expect(new IdentityService(rootRole, rootDb, () => now).removalUrl()).toBeUndefined();
  });

  it('sends nobody on where it holds no signing key', async () => {
    expect(await new IdentityService({ role: 'instance' } as RoleConfig, rootDb, () => now).goUrl({ id: 'u1', email: 'e' })).toBeUndefined();
  });

  it('reads its clock when it is not given one', async () => {
    const url = await new IdentityService(rootRole, rootDb).register({ id: 'inst-u9', ownerId: 'u9', url: 'https://u9.example.com' });
    expect(url.ok && Date.parse(url.instance.createdAt)).toBeGreaterThan(Date.parse('2026-01-01'));
  });
});
