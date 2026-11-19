import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { publicJwkOf, type SignInKey } from '../../instances/lib/oidc.js';
import { objectWith } from '../../platform/lib/test-matchers.js';
import type { ProjectInviteService } from '../services/ProjectInviteService.js';
import { routesInProcess } from '../../platform/testing/routes.js';
import { hubLinkRouter } from './hub-link.js';

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const jwk = publicJwkOf(identityKeysFrom(generateIdentityKey()));
const invite = { email: 'cy@example.com', inviterToken: 'ann-at-the-hub', projectName: 'Shop', role: 'client', join: 'J'.repeat(32) };
const people = [{ id: 'ann', email: 'ann@example.com' }, { id: 'gone', email: 'gone@example.com', removal: { at: 'x' } }];

async function root(options: { credentialHash?: string | undefined; keys?: boolean } = {}) {
  const invites = mock<ProjectInviteService>();
  let held: SignInKey | undefined;
  const routes = await routesInProcess({
    prefix: '/api/hub-link',
    router: () => hubLinkRouter({
      invites,
      credentialHash: 'credentialHash' in options ? options.credentialHash : hash('the-hub'),
      hash,
      signInKeys: options.keys === false ? undefined : { get: async () => held, save: async (key) => { held = key; } },
      provider: {
        serviceCaller: async (token) => (token === 'a-hub-service-token' ? { clientId: 'hub', kind: 'hub' } : token === 'an-instance-service-token' ? { clientId: 'inst', kind: 'instance' } : undefined),
        personAtHub: async (token) => ({ 'ann-at-the-hub': 'ann', 'gone-at-the-hub': 'gone' } as Record<string, string>)[token],
      },
      people: { getUserById: async (id) => people.find((person) => person.id === id) },
    }),
    user: null,
    open: true,
  });
  return { invites, routes, held: () => held };
}

const asHub = { authorization: 'Bearer the-hub' };

describe('/api/hub-link/sign-in-key', () => {
  it('takes the hub\'s sign-in key only from the hub, and only a key named by its own thumbprint', async () => {
    const { routes, held } = await root();
    expect((await routes.put('/api/hub-link/sign-in-key', { jwk })).status).toBe(401);
    expect((await routes.put('/api/hub-link/sign-in-key', { jwk }, { headers: { authorization: 'Bearer someone-else' } })).status).toBe(401);
    expect((await routes.put('/api/hub-link/sign-in-key', { jwk: { ...jwk, kid: 'chosen' } }, { headers: asHub })).status).toBe(400);
    const named = await routes.put('/api/hub-link/sign-in-key', { jwk }, { headers: asHub });
    expect(named.status).toBe(200);
    expect(held()).toEqual({ jwk, since: (named.data as { since: string }).since });
    const again = await routes.put('/api/hub-link/sign-in-key', { jwk }, { headers: asHub });
    expect((again.data as { since: string }).since).toBe((named.data as { since: string }).since);
  });

  it('keeps no key when it has nowhere to keep one, or no credential for the hub', async () => {
    expect((await (await root({ keys: false })).routes.put('/api/hub-link/sign-in-key', { jwk }, { headers: asHub })).status).toBe(401);
    expect((await (await root({ credentialHash: undefined })).routes.put('/api/hub-link/sign-in-key', { jwk }, { headers: asHub })).status).toBe(401);
  });

  it('starts the key\'s age afresh when the hub names another key', async () => {
    const { routes, held } = await root();
    const other = publicJwkOf(identityKeysFrom(generateIdentityKey()));
    await routes.put('/api/hub-link/sign-in-key', { jwk }, { headers: asHub });
    await routes.put('/api/hub-link/sign-in-key', { jwk: other }, { headers: asHub });
    expect(held()?.jwk.kid).toBe(other.kid);
  });
});

describe('/api/hub-link/invite', () => {
  it('sends an invite only for its own hub, by its credential or its service token, never an instance\'s', async () => {
    const { routes, invites } = await root();
    invites.send.mockResolvedValue({ link: 'l', emailed: false } as never);
    expect((await routes.post('/api/hub-link/invite', invite)).status).toBe(401);
    expect((await routes.post('/api/hub-link/invite', invite, { headers: { authorization: 'Bearer someone-else' } })).status).toBe(401);
    expect((await routes.post('/api/hub-link/invite', invite, { headers: { authorization: 'Bearer an-instance-service-token' } })).status).toBe(401);
    expect((await routes.post('/api/hub-link/invite', invite, { headers: asHub })).status).toBe(201);
    expect((await routes.post('/api/hub-link/invite', invite, { headers: { authorization: 'Bearer a-hub-service-token' } })).status).toBe(201);
  });

  it('takes the inviter from the sign-in root gave them at the hub, never from what the hub says', async () => {
    const { routes, invites } = await root();
    invites.send.mockResolvedValue({ link: 'l', emailed: true } as never);
    const answer = await routes.post('/api/hub-link/invite', { ...invite, inviterId: 'boss', inviterEmail: 'boss@example.com' }, { headers: asHub });
    expect([answer.status, answer.data]).toEqual([201, { link: 'l', emailed: true }]);
    expect(invites.send).toHaveBeenCalledWith({ email: 'cy@example.com', projectName: 'Shop', role: 'client', join: 'J'.repeat(32), inviterId: 'ann', inviterEmail: 'ann@example.com' });
  });

  it('refuses an invite whose inviter root does not know, or whose account is being removed', async () => {
    const { routes, invites } = await root();
    expect((await routes.post('/api/hub-link/invite', { ...invite, inviterToken: 'made-up' }, { headers: asHub })).status).toBe(403);
    expect((await routes.post('/api/hub-link/invite', { ...invite, inviterToken: 'gone-at-the-hub' }, { headers: asHub })).status).toBe(403);
    expect(invites.send).not.toHaveBeenCalled();
  });

  it('refuses an invite that leaves a field out or names a role there is not', async () => {
    const { routes } = await root();
    for (const field of ['email', 'projectName', 'role', 'join', 'inviterToken']) {
      const answer = await routes.post('/api/hub-link/invite', { ...invite, [field]: ' ' }, { headers: asHub });
      expect([answer.status, answer.data]).toEqual([400, { error: 'an invite names email, projectName, role, join, inviterToken' }]);
    }
    expect(await routes.post('/api/hub-link/invite', { ...invite, role: 'emperor' }, { headers: asHub })).toMatchObject({ status: 400, data: { error: 'that is not a role on a project' } });
  });

  it('answers 429 with root\'s reason when the inviter has sent too many', async () => {
    const { routes, invites } = await root();
    invites.send.mockResolvedValue({ refused: 'too many invites' });
    expect(await routes.post('/api/hub-link/invite', invite, { headers: asHub })).toMatchObject({ status: 429, data: { error: 'too many invites' } });
  });

  it('refuses a body that is not there at all', async () => {
    const { routes } = await root();
    expect((await routes.post('/api/hub-link/invite', undefined, { headers: asHub })).status).toBe(400);
  });
});

describe('/api/hub-link/invitation', () => {
  it('shows an invite to whoever holds its code', async () => {
    const { routes, invites } = await root();
    invites.invitation.calledWith('the-code').mockResolvedValue({ email: 'cy@example.com', project: objectWith({ name: 'Shop' }) as never, used: false });
    const answer = await routes.get('/api/hub-link/invitation?code=the-code');
    expect([answer.status, (answer.data as { email: string }).email]).toEqual([200, 'cy@example.com']);
  });

  it('says there is none for a code that is unknown or not given', async () => {
    const { routes, invites } = await root();
    invites.invitation.mockResolvedValue(undefined);
    expect((await routes.get('/api/hub-link/invitation?code=nope')).status).toBe(404);
    expect((await routes.get('/api/hub-link/invitation')).status).toBe(404);
    expect(invites.invitation).toHaveBeenCalledTimes(1);
  });
});
