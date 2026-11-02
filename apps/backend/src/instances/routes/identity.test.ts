import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { callRouter, PERSON } from '../testing/call-router.js';
import { identityRouter } from './identity.js';
import type { IdentityService } from '../services/IdentityService.js';
import type { InstanceRecord } from '../lib/instances.js';

type Identity = Pick<IdentityService, 'publicKeys' | 'instanceOf' | 'goUrl'>;

const instance: InstanceRecord = { id: 'inst-test', ownerId: PERSON.id, url: 'https://test.example.com', createdAt: 'x', updatedAt: 'x' };
const signedInWhenCookie = async (req: { headers: { cookie?: string | undefined } }) => (req.headers.cookie?.includes('session=ok') ? PERSON : undefined);

describe('root\'s identity routes', () => {
  it('publishes its public keys', async () => {
    const identity = mock<Identity>();
    identity.publicKeys.mockReturnValue([{ kid: 'k1', publicKey: 'PEM' }]);
    const answer = await callRouter(identityRouter({ identity, servesTenants: false, signedIn: signedInWhenCookie }), '/api/identity', { path: '/keys' });
    expect(answer.body).toEqual({ keys: [{ kid: 'k1', publicKey: 'PEM' }] });
  });

  it('tells a person where their instance is, and that it is down only once root has said so', async () => {
    const identity = mock<Identity>();
    identity.instanceOf.calledWith(PERSON.id).mockResolvedValue(instance);
    const router = (reach: { reachable: boolean; unreachableSince: string; toldDown?: boolean } | undefined) =>
      identityRouter({ identity, servesTenants: true, signedIn: signedInWhenCookie, reachOf: async () => reach });
    expect((await callRouter(router(undefined), '/api/identity', { path: '/instance' })).body).toEqual({ instance: { id: 'inst-test', url: 'https://test.example.com' }, servesTenants: true });
    expect((await callRouter(router({ reachable: false, unreachableSince: '2026-10-29T10:00:00.000Z' }), '/api/identity', { path: '/instance' })).body).toEqual({ instance: { id: 'inst-test', url: 'https://test.example.com' }, servesTenants: true });
    expect((await callRouter(router({ reachable: false, unreachableSince: '2026-10-29T10:00:00.000Z', toldDown: true }), '/api/identity', { path: '/instance' })).body).toEqual({
      instance: { id: 'inst-test', url: 'https://test.example.com', unreachableSince: '2026-10-29T10:00:00.000Z' }, servesTenants: true,
    });
  });

  it('says there is no instance yet, and asks nobody whether it is reachable', async () => {
    const identity = mock<Identity>();
    identity.instanceOf.mockResolvedValue(undefined);
    let asked = 0;
    const answer = await callRouter(identityRouter({ identity, servesTenants: false, signedIn: signedInWhenCookie, reachOf: async () => { asked += 1; return undefined; } }), '/api/identity', { path: '/instance' });
    expect(answer.body).toEqual({ instance: null, servesTenants: false });
    expect(asked).toBe(0);
  });

  it('sends a signed-out visitor to the front page', async () => {
    const identity = mock<Identity>();
    const answer = await callRouter(identityRouter({ identity, servesTenants: false, signedIn: signedInWhenCookie }), '/api/identity', { path: '/go' });
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('/');
    expect(answer.headers['cache-control']).toBe('no-store');
  });

  it('redirects a signed-in person to the address root gives them, passing on the nonce', async () => {
    const identity = mock<Identity>();
    identity.goUrl.calledWith(PERSON, undefined, 'n'.repeat(32)).mockResolvedValue('https://test.example.com/#/handoff?token=t');
    const answer = await callRouter(identityRouter({ identity, servesTenants: false, signedIn: signedInWhenCookie }), '/api/identity', { path: `/go?nonce=${'n'.repeat(32)}`, headers: { cookie: 'session=ok' } });
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe('https://test.example.com/#/handoff?token=t');
    expect(answer.headers['cache-control']).toBe('no-store');
  });

  it('sends a person to the hub, carrying where they were going', async () => {
    const identity = mock<Identity>();
    identity.goUrl.calledWith(PERSON, matches<{ hub: true; next?: string | undefined } | undefined>((to) => to?.hub === true && to.next === '/hub/join/abc'), undefined).mockResolvedValue('https://hub.example.com/api/auth/oidc/start');
    const answer = await callRouter(identityRouter({ identity, servesTenants: false, signedIn: signedInWhenCookie }), '/api/identity', { path: '/go?to=hub&next=%2Fhub%2Fjoin%2Fabc', headers: { cookie: 'session=ok' } });
    expect(answer.headers.location).toBe('https://hub.example.com/api/auth/oidc/start');
  });

  it('says why there is nowhere to send a person', async () => {
    const identity = mock<Identity>();
    identity.goUrl.mockResolvedValue(undefined);
    const router = identityRouter({ identity, servesTenants: false, signedIn: signedInWhenCookie });
    const noInstance = await callRouter(router, '/api/identity', { path: '/go', headers: { cookie: 'session=ok' } });
    expect([noInstance.status, noInstance.body]).toEqual([404, { error: 'you have no instance yet' }]);
    const noHub = await callRouter(router, '/api/identity', { path: '/go?to=hub', headers: { cookie: 'session=ok' } });
    expect([noHub.status, noHub.body]).toEqual([404, { error: 'this root has no hub' }]);
  });
});
