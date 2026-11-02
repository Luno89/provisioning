import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { publicJwkOf, type SignInKey } from '../../instances/lib/oidc.js';
import { objectWith } from '../../platform/lib/test-matchers.js';
import type { ProjectInviteService } from '../services/ProjectInviteService.js';
import { callRouter } from '../testing/call-router.js';
import { hubLinkRouter } from './hub-link.js';

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const jwk = publicJwkOf(identityKeysFrom(generateIdentityKey()));
const invite = { email: 'cy@example.com', inviterToken: 'ann-at-the-hub', projectName: 'Shop', role: 'client', join: 'J'.repeat(32) };
const people = [{ id: 'ann', email: 'ann@example.com' }, { id: 'gone', email: 'gone@example.com', removal: { at: 'x' } }];

function root(options: { credentialHash?: string | undefined; keys?: boolean } = {}) {
  const invites = mock<ProjectInviteService>();
  let held: SignInKey | undefined;
  const router = hubLinkRouter({
    invites,
    credentialHash: 'credentialHash' in options ? options.credentialHash : hash('the-hub'),
    hash,
    signInKeys: options.keys === false ? undefined : { get: async () => held, save: async (key) => { held = key; } },
    serviceCaller: async (token) => (token === 'a-hub-service-token' ? { clientId: 'hub', kind: 'hub' } : token === 'an-instance-service-token' ? { clientId: 'inst', kind: 'instance' } : undefined),
    personAtHub: async (token) => ({ 'ann-at-the-hub': 'ann', 'gone-at-the-hub': 'gone' } as Record<string, string>)[token],
    people: { getUserById: async (id) => people.find((person) => person.id === id) },
  });
  const call = (route: Parameters<typeof callRouter>[2]) => callRouter(router, '/api/hub-link', route);
  return { invites, call, held: () => held };
}

const asHub = { authorization: 'Bearer the-hub' };

describe('/api/hub-link/sign-in-key', () => {
  it('takes the hub\'s sign-in key only from the hub, and only a key named by its own thumbprint', async () => {
    const { call, held } = root();
    expect((await call({ method: 'PUT', path: '/sign-in-key', json: { jwk } })).status).toBe(401);
    expect((await call({ method: 'PUT', path: '/sign-in-key', json: { jwk }, headers: { authorization: 'Bearer someone-else' } })).status).toBe(401);
    expect((await call({ method: 'PUT', path: '/sign-in-key', json: { jwk: { ...jwk, kid: 'chosen' } }, headers: asHub })).status).toBe(400);
    const named = await call({ method: 'PUT', path: '/sign-in-key', json: { jwk }, headers: asHub });
    expect(named.status).toBe(200);
    expect(held()).toEqual({ jwk, since: (named.body as { since: string }).since });
    const again = await call({ method: 'PUT', path: '/sign-in-key', json: { jwk }, headers: asHub });
    expect((again.body as { since: string }).since).toBe((named.body as { since: string }).since);
  });

  it('keeps no key when it has nowhere to keep one, or no credential for the hub', async () => {
    expect((await root({ keys: false }).call({ method: 'PUT', path: '/sign-in-key', json: { jwk }, headers: asHub })).status).toBe(401);
    expect((await root({ credentialHash: undefined }).call({ method: 'PUT', path: '/sign-in-key', json: { jwk }, headers: asHub })).status).toBe(401);
  });

  it('starts the key\'s age afresh when the hub names another key', async () => {
    const { call, held } = root();
    const other = publicJwkOf(identityKeysFrom(generateIdentityKey()));
    await call({ method: 'PUT', path: '/sign-in-key', json: { jwk }, headers: asHub });
    await call({ method: 'PUT', path: '/sign-in-key', json: { jwk: other }, headers: asHub });
    expect(held()?.jwk.kid).toBe(other.kid);
  });
});

describe('/api/hub-link/invite', () => {
  it('sends an invite only for its own hub, by its credential or its service token, never an instance\'s', async () => {
    const { call, invites } = root();
    invites.send.mockResolvedValue({ link: 'l', emailed: false } as never);
    expect((await call({ method: 'POST', path: '/invite', json: invite })).status).toBe(401);
    expect((await call({ method: 'POST', path: '/invite', json: invite, headers: { authorization: 'Bearer someone-else' } })).status).toBe(401);
    expect((await call({ method: 'POST', path: '/invite', json: invite, headers: { authorization: 'Bearer an-instance-service-token' } })).status).toBe(401);
    expect((await call({ method: 'POST', path: '/invite', json: invite, headers: asHub })).status).toBe(201);
    expect((await call({ method: 'POST', path: '/invite', json: invite, headers: { authorization: 'Bearer a-hub-service-token' } })).status).toBe(201);
  });

  it('takes the inviter from the sign-in root gave them at the hub, never from what the hub says', async () => {
    const { call, invites } = root();
    invites.send.mockResolvedValue({ link: 'l', emailed: true } as never);
    const answer = await call({ method: 'POST', path: '/invite', json: { ...invite, inviterId: 'boss', inviterEmail: 'boss@example.com' }, headers: asHub });
    expect([answer.status, answer.body]).toEqual([201, { link: 'l', emailed: true }]);
    expect(invites.send).toHaveBeenCalledWith({ email: 'cy@example.com', projectName: 'Shop', role: 'client', join: 'J'.repeat(32), inviterId: 'ann', inviterEmail: 'ann@example.com' });
  });

  it('refuses an invite whose inviter root does not know, or whose account is being removed', async () => {
    const { call, invites } = root();
    expect((await call({ method: 'POST', path: '/invite', json: { ...invite, inviterToken: 'made-up' }, headers: asHub })).status).toBe(403);
    expect((await call({ method: 'POST', path: '/invite', json: { ...invite, inviterToken: 'gone-at-the-hub' }, headers: asHub })).status).toBe(403);
    expect(invites.send).not.toHaveBeenCalled();
  });

  it('refuses an invite that leaves a field out or names a role there is not', async () => {
    const { call } = root();
    for (const field of ['email', 'projectName', 'role', 'join', 'inviterToken']) {
      const answer = await call({ method: 'POST', path: '/invite', json: { ...invite, [field]: ' ' }, headers: asHub });
      expect([answer.status, answer.body]).toEqual([400, { error: 'an invite names email, projectName, role, join, inviterToken' }]);
    }
    expect(await call({ method: 'POST', path: '/invite', json: { ...invite, role: 'emperor' }, headers: asHub })).toMatchObject({ status: 400, body: { error: 'that is not a role on a project' } });
  });

  it('answers 429 with root\'s reason when the inviter has sent too many', async () => {
    const { call, invites } = root();
    invites.send.mockResolvedValue({ refused: 'too many invites' });
    expect(await call({ method: 'POST', path: '/invite', json: invite, headers: asHub })).toMatchObject({ status: 429, body: { error: 'too many invites' } });
  });

  it('refuses a body that is not there at all', async () => {
    const { call } = root();
    expect((await call({ method: 'POST', path: '/invite', headers: asHub })).status).toBe(400);
  });
});

describe('/api/hub-link/invitation', () => {
  it('shows an invite to whoever holds its code', async () => {
    const { call, invites } = root();
    invites.invitation.calledWith('the-code').mockResolvedValue({ email: 'cy@example.com', project: objectWith({ name: 'Shop' }) as never, used: false });
    const answer = await call({ path: '/invitation?code=the-code' });
    expect([answer.status, (answer.body as { email: string }).email]).toEqual([200, 'cy@example.com']);
  });

  it('says there is none for a code that is unknown or not given', async () => {
    const { call, invites } = root();
    invites.invitation.mockResolvedValue(undefined);
    expect((await call({ path: '/invitation?code=nope' })).status).toBe(404);
    expect((await call({ path: '/invitation' })).status).toBe(404);
    expect(invites.invitation).toHaveBeenCalledTimes(1);
  });
});
