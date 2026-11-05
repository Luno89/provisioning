import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { Router } from 'express';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import { identityRouter } from './identity.js';
import type { IdentityService } from '../services/IdentityService.js';
import type { InstanceRecord } from '../lib/instances.js';

const get = async (router: Router, path: string, headers?: Record<string, string>) =>
  (await routesInProcess({ prefix: '/api/identity', router: () => router, user: PERSON })).get(`/api/identity${path}`, headers ? { headers } : {});

type Identity = Pick<IdentityService, 'publicKeys' | 'instanceOf' | 'goUrl'>;

const instance: InstanceRecord = { id: 'inst-test', ownerId: PERSON.id, url: 'https://test.example.com', createdAt: 'x', updatedAt: 'x' };
const signedInWhenCookie = async (req: { headers: { cookie?: string | undefined } }) => (req.headers.cookie?.includes('session=ok') ? PERSON : undefined);

describe('root\'s identity routes', () => {
  it('publishes its public keys', async () => {
    const identity = mock<Identity>();
    identity.publicKeys.mockReturnValue([{ kid: 'k1', publicKey: 'PEM' }]);
    const answer = await get(identityRouter({ servesTenants: false, accounts: { identity, signedIn: signedInWhenCookie } }), '/keys');
    expect(answer.data).toEqual({ keys: [{ kid: 'k1', publicKey: 'PEM' }] });
  });

  it('tells a person where their instance is, and that it is down only once root has said so', async () => {
    const identity = mock<Identity>();
    identity.instanceOf.calledWith(PERSON.id).mockResolvedValue(instance);
    const router = (reach: { reachable: boolean; unreachableSince: string; toldDown?: boolean } | undefined) =>
      identityRouter({ servesTenants: true, accounts: { identity, signedIn: signedInWhenCookie, reachOf: async () => reach } });
    expect((await get(router(undefined), '/instance')).data).toEqual({ instance: { id: 'inst-test', url: 'https://test.example.com' }, servesTenants: true });
    expect((await get(router({ reachable: false, unreachableSince: '2026-10-29T10:00:00.000Z' }), '/instance')).data).toEqual({ instance: { id: 'inst-test', url: 'https://test.example.com' }, servesTenants: true });
    expect((await get(router({ reachable: false, unreachableSince: '2026-10-29T10:00:00.000Z', toldDown: true }), '/instance')).data).toEqual({
      instance: { id: 'inst-test', url: 'https://test.example.com', unreachableSince: '2026-10-29T10:00:00.000Z' }, servesTenants: true,
    });
  });

  it('says there is no instance yet, and asks nobody whether it is reachable', async () => {
    const identity = mock<Identity>();
    identity.instanceOf.mockResolvedValue(undefined);
    let asked = 0;
    const answer = await get(identityRouter({ servesTenants: false, accounts: { identity, signedIn: signedInWhenCookie, reachOf: async () => { asked += 1; return undefined; } } }), '/instance');
    expect(answer.data).toEqual({ instance: null, servesTenants: false });
    expect(asked).toBe(0);
  });

  it('sends a signed-out visitor to the front page', async () => {
    const identity = mock<Identity>();
    const answer = await get(identityRouter({ servesTenants: false, accounts: { identity, signedIn: signedInWhenCookie } }), '/go');
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('/');
    expect(answer.headers['cache-control']).toBe('no-store');
  });

  it('redirects a signed-in person to the address root gives them, passing on the nonce', async () => {
    const identity = mock<Identity>();
    identity.goUrl.calledWith(PERSON, undefined, 'n'.repeat(32)).mockResolvedValue('https://test.example.com/#/handoff?token=t');
    const answer = await get(identityRouter({ servesTenants: false, accounts: { identity, signedIn: signedInWhenCookie } }), `/go?nonce=${'n'.repeat(32)}`, { cookie: 'session=ok' });
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('https://test.example.com/#/handoff?token=t');
    expect(answer.headers['cache-control']).toBe('no-store');
  });

  it('sends a person to the hub, carrying where they were going', async () => {
    const identity = mock<Identity>();
    identity.goUrl.calledWith(PERSON, matches<{ hub: true; next?: string | undefined } | undefined>((to) => to?.hub === true && to.next === '/hub/join/abc'), undefined).mockResolvedValue('https://hub.example.com/api/auth/oidc/start');
    const answer = await get(identityRouter({ servesTenants: false, accounts: { identity, signedIn: signedInWhenCookie } }), '/go?to=hub&next=%2Fhub%2Fjoin%2Fabc', { cookie: 'session=ok' });
    expect(answer.headers.location).toBe('https://hub.example.com/api/auth/oidc/start');
  });

  it('says why there is nowhere to send a person', async () => {
    const identity = mock<Identity>();
    identity.goUrl.mockResolvedValue(undefined);
    const router = identityRouter({ servesTenants: false, accounts: { identity, signedIn: signedInWhenCookie } });
    const noInstance = await get(router, '/go', { cookie: 'session=ok' });
    expect([noInstance.status, noInstance.data]).toEqual([404, { error: 'you have no instance yet' }]);
    const noHub = await get(router, '/go?to=hub', { cookie: 'session=ok' });
    expect([noHub.status, noHub.data]).toEqual([404, { error: 'this root has no hub' }]);
  });
});

describe('where a person is, on a backend that holds no accounts', () => {
  it('says there is no instance of theirs elsewhere, and whether this place serves tenants', async () => {
    expect((await get(identityRouter({ servesTenants: true }), '/instance')).data).toEqual({ instance: null, servesTenants: true });
    expect((await get(identityRouter({ servesTenants: false }), '/instance')).data).toEqual({ instance: null, servesTenants: false });
  });
});
