import { describe, it, expect } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { IdentityService } from './IdentityService.js';
import { generateIdentityKey, identityKeysFrom } from '../lib/identity-token.js';
import type { RoleConfig } from '../../platform/lib/platform-role.js';
import { signingInAtRoot } from '../testing/identity-service-behaviour.js';

const containing = (text: string): unknown => expect.stringContaining(text);

signingInAtRoot(async () => memoryDatabase());

const signing = identityKeysFrom(generateIdentityKey());
const rootRole: RoleConfig = { role: 'root', signing };
const rootDb = memoryDatabase();

describe('what root and an instance say about each other', () => {
  it('publishes the key root signs with, and none when it signs nothing', () => {
    expect(new IdentityService(rootRole, rootDb).publicKeys()).toEqual([{ kid: signing.kid, publicKey: containing('BEGIN PUBLIC KEY') }]);
    expect(new IdentityService({ role: 'instance' } as RoleConfig, rootDb).publicKeys()).toEqual([]);
  });

  it('hands an instance the address at root for removing an account', () => {
    const instance = new IdentityService({ role: 'instance', instance: { id: 'inst-u1', ownerId: 'u1', rootUrl: 'https://app.example.com', rootPublicKeys: [] } } as unknown as RoleConfig, rootDb);
    expect(instance.removalUrl()).toBe('https://app.example.com/#/remove-account');
    expect(new IdentityService(rootRole, rootDb).removalUrl()).toBeUndefined();
  });

  it('sends nobody on where it holds no signing key', async () => {
    expect(await new IdentityService({ role: 'instance' } as RoleConfig, rootDb).goUrl({ id: 'u1', email: 'e' })).toBeUndefined();
  });
});
