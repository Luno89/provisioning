import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Router } from 'express';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';
import { identityRouter } from './identity.js';
import type { IdentityService } from '../services/IdentityService.js';
import type { InstanceRecord } from '../lib/instances.js';

const get = async (router: Router, path: string, headers?: Record<string, string>) =>
  (await routesInProcess({ prefix: '/api/identity', router: () => router, user: PERSON })).get(`/api/identity${path}`, headers ? { headers } : {});

type Identity = Pick<IdentityService, 'publicKeys' | 'instanceOf' | 'goUrl'>;

const announced = { jwk: { kty: 'OKP' as const, crv: 'Ed25519' as const, x: 'x', kid: 'k' }, since: '2026-10-29T00:00:00.000Z' };
const instance: InstanceRecord = { id: 'inst-test', ownerId: PERSON.id, url: 'https://test.example.com', createdAt: 'x', updatedAt: 'x', signIn: announced };
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

  it('tells a person whose instance has not registered at root that it has not yet', async () => {
    const identity = mock<Identity>();
    identity.instanceOf.calledWith(PERSON.id).mockResolvedValue({ ...instance, signIn: undefined });
    const answer = await get(identityRouter({ servesTenants: false, accounts: { identity, signedIn: signedInWhenCookie } }), '/instance');
    expect(answer.data).toEqual({ instance: { id: 'inst-test', url: 'https://test.example.com', signInWaiting: 'your Koala has not registered at root yet; it does so as it starts, with the code root gave it when it was put on your machine' }, servesTenants: false });
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

  it('redirects a signed-in person to their instance\'s own sign-in start', async () => {
    const identity = mock<Identity>();
    identity.goUrl.calledWith(PERSON).mockResolvedValue({ url: 'https://test.example.com/api/auth/oidc/start' });
    const answer = await get(identityRouter({ servesTenants: false, accounts: { identity, signedIn: signedInWhenCookie } }), '/go', { cookie: 'session=ok' });
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('https://test.example.com/api/auth/oidc/start');
    expect(answer.headers['cache-control']).toBe('no-store');
  });

  it('says why there is nowhere to send a person', async () => {
    const identity = mock<Identity>();
    identity.goUrl.mockResolvedValue(undefined);
    const router = identityRouter({ servesTenants: false, accounts: { identity, signedIn: signedInWhenCookie } });
    const noInstance = await get(router, '/go', { cookie: 'session=ok' });
    expect([noInstance.status, noInstance.data]).toEqual([404, { error: 'you have no instance yet' }]);
  });

  it('tells a person their instance has not registered at root yet, rather than sending them on', async () => {
    const identity = mock<Identity>();
    identity.goUrl.mockResolvedValue({ waiting: 'your Koala has not registered at root yet; it does so as it starts, with the code root gave it when it was put on your machine' });
    const answer = await get(identityRouter({ servesTenants: false, accounts: { identity, signedIn: signedInWhenCookie } }), '/go', { cookie: 'session=ok' });
    expect([answer.status, answer.data, answer.headers.location]).toEqual([409, { error: 'your Koala has not registered at root yet; it does so as it starts, with the code root gave it when it was put on your machine' }, undefined]);
  });
});

describe('where a person is, on a backend that holds no accounts', () => {
  it('says there is no instance of theirs elsewhere, and whether this place serves tenants', async () => {
    expect((await get(identityRouter({ servesTenants: true }), '/instance')).data).toEqual({ instance: null, servesTenants: true });
    expect((await get(identityRouter({ servesTenants: false }), '/instance')).data).toEqual({ instance: null, servesTenants: false });
  });
});
