import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from '../../platform/index.js';
import { IdentityService } from '../services/IdentityService.js';
import { generateIdentityKey, identityKeysFrom } from '../lib/identity-token.js';
import type { RoleConfig } from '../../platform/lib/platform-role.js';

export function signingInAtRoot(database: () => Promise<Pick<Database, 'instances' | 'accounts'>>): void {
  const signing = identityKeysFrom(generateIdentityKey());
  const rootRole: RoleConfig = { role: 'root', signing };
  const announced = { jwk: { kty: 'OKP' as const, crv: 'Ed25519' as const, x: 'x', kid: 'k' }, since: '2026-10-29T00:00:00.000Z' };
  let rootDb: Pick<Database, 'instances' | 'accounts'>;

  beforeEach(async () => {
    rootDb = await database();
  });

  describe('signing in at root and landing on your own instance', () => {
    it('sends a signed-in owner to their instance\'s own sign-in start, never a handoff', async () => {
      const root = new IdentityService(rootRole, rootDb);
      await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com', createdAt: 'x', updatedAt: 'x' });
      await rootDb.instances.saveSignInKey('inst-u1', announced);
      expect(await root.goUrl({ id: 'u1', email: 'u1@example.com' })).toEqual({ url: 'https://u1.example.com/api/auth/oidc/start' });
    });

    it('tells the owner of an instance that has not named its key so, instead of sending them on', async () => {
      const root = new IdentityService(rootRole, rootDb);
      await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: 'https://u1.example.com', createdAt: 'x', updatedAt: 'x' });
      expect(await root.goUrl({ id: 'u1', email: 'u1@example.com' })).toEqual({ waiting: 'your Koala has not registered at root yet; it does so as it starts, with the code root gave it when it was put on your machine' });
    });

    it('issues nothing for a user with no instance', async () => {
      const root = new IdentityService(rootRole, rootDb);
      expect(await root.goUrl({ id: 'nobody', email: 'n@example.com' })).toBeUndefined();
    });

    it('sends no one to an instance that is still being set up', async () => {
      const root = new IdentityService(rootRole, rootDb);
      await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: '', createdAt: 'x', updatedAt: 'x', status: 'waiting' });
      expect(await root.goUrl({ id: 'u1', email: 'e' })).toBeUndefined();
      await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: 'http://100.64.0.7:30320', createdAt: 'x', updatedAt: 'x', status: 'installing' });
      expect(await root.goUrl({ id: 'u1', email: 'e' })).toBeUndefined();
      await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: 'http://100.64.0.7:30320', createdAt: 'x', updatedAt: 'x', status: 'ready', signIn: announced });
      expect(await root.goUrl({ id: 'u1', email: 'e' })).toEqual({ url: 'http://100.64.0.7:30320/api/auth/oidc/start' });
    });

    it('keeps sending its owner to an instance while it upgrades itself and after it rolls a failed upgrade back', async () => {
      const root = new IdentityService(rootRole, rootDb);
      await rootDb.instances.saveInstance({ id: 'inst-u1', ownerId: 'u1', url: 'http://100.64.0.7:30320', createdAt: 'x', updatedAt: '2026-10-23T01:00:00.000Z', status: 'ready', signIn: announced });
      const stored = (await rootDb.instances.getInstances('u1'))[0]!;
      expect(stored.servedAt).toBe('2026-10-23T01:00:00.000Z');
      await rootDb.instances.saveInstance({ ...stored, status: 'installing', detail: 'Upgrading from a to b', updatedAt: '2026-10-24T01:00:00.000Z' });
      expect(await root.goUrl({ id: 'u1', email: 'e' })).toEqual({ url: 'http://100.64.0.7:30320/api/auth/oidc/start' });
      await rootDb.instances.saveInstance({ ...stored, status: 'failed', detail: 'The upgrade to b failed, so it was rolled back to a', updatedAt: '2026-10-24T02:00:00.000Z' });
      expect(await root.goUrl({ id: 'u1', email: 'e' })).toEqual({ url: 'http://100.64.0.7:30320/api/auth/oidc/start' });
    });
  });
}
