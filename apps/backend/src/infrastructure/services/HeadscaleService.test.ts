import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { HeadscaleService } from './HeadscaleService.js';

const BASE = 'http://headscale.test';
const server = interceptHttp();
const service = () => new HeadscaleService('master-key', { headscaleUrl: BASE, headscaleApiKey: '  api-key  ' });
const authorized = (request: Request): boolean => request.headers.get('authorization') === 'Bearer api-key';

const knowsUser = (name: string, id = '7') => http.get(`${BASE}/api/v1/user`, ({ request }) => (authorized(request) && new URL(request.url).searchParams.get('name') === name ? HttpResponse.json({ users: [{ id, name }] }) : HttpResponse.json({ users: [] })));

describe('HeadscaleService', () => {
  it('signs every call with the api key it was given, trimmed', async () => {
    server.use(knowsUser('platform-u1'), http.get(`${BASE}/api/v1/node`, ({ request }) => (authorized(request) ? HttpResponse.json({ nodes: [] }) : new HttpResponse(null, { status: 401 }))));
    expect(await service().listUserDevices('u1')).toEqual([]);
  });

  it('makes the person\'s mesh user the first time and remembers it', async () => {
    let created = 0;
    server.use(
      http.get(`${BASE}/api/v1/user`, () => HttpResponse.json({ users: [] })),
      http.post(`${BASE}/api/v1/user`, async ({ request }) => { created += 1; expect(await request.json()).toEqual({ name: 'platform-u1' }); return HttpResponse.json({ user: { id: '9' } }); }),
      http.get(`${BASE}/api/v1/node`, () => HttpResponse.json({ nodes: [] })),
    );
    const headscale = service();
    await headscale.listUserDevices('u1');
    await headscale.listUserDevices('u1');
    expect(created).toBe(1);
  });

  it('says why the user could not be listed or made', async () => {
    server.use(http.get(`${BASE}/api/v1/user`, () => new HttpResponse(null, { status: 500 })));
    await expect(service().listUserDevices('u1')).rejects.toThrow('Failed to list Headscale users: HTTP 500');
    server.use(http.get(`${BASE}/api/v1/user`, () => HttpResponse.json({ users: [] })), http.post(`${BASE}/api/v1/user`, () => new HttpResponse('nope', { status: 400 })));
    await expect(service().listUserDevices('u2')).rejects.toThrow('Failed to create Headscale user "platform-u2": HTTP 400 nope');
  });

  it('lists a person\'s machines with their addresses and whether they are online', async () => {
    server.use(knowsUser('platform-u1'), http.get(`${BASE}/api/v1/node`, ({ request }) => (new URL(request.url).searchParams.get('user') === 'platform-u1'
      ? HttpResponse.json({ nodes: [{ id: '1', name: 'laptop', ipAddresses: ['100.64.0.2'], online: true, lastSeen: 'then' }, { id: '2', name: 'box' }] })
      : HttpResponse.json({ nodes: [] }))));
    expect(await service().listUserDevices('u1')).toEqual([
      { id: '1', name: 'laptop', ipAddresses: ['100.64.0.2'], online: true, lastSeen: 'then' },
      { id: '2', name: 'box', ipAddresses: [], online: false },
    ]);
  });

  it('makes a pre-auth key for the person\'s mesh user, reusable and expiring as asked', async () => {
    server.use(knowsUser('platform-u1', '7'), http.post(`${BASE}/api/v1/preauthkey`, async ({ request }) => {
      const body = await request.json() as { user: string; reusable: boolean; ephemeral: boolean; expiration: string };
      expect(body).toMatchObject({ user: '7', reusable: true, ephemeral: false });
      expect(Date.parse(body.expiration) - Date.now()).toBeGreaterThan(590_000);
      return HttpResponse.json({ preAuthKey: { key: 'tskey-1', expiration: body.expiration } });
    }));
    expect(await service().createPreAuthKey('u1', { reusable: true, expirySeconds: 600 })).toMatchObject({ key: 'tskey-1' });
  });

  it('makes a single-use key lasting an hour when nothing is asked, and says why one could not be made', async () => {
    server.use(knowsUser('platform-u1'), http.post(`${BASE}/api/v1/preauthkey`, async ({ request }) => {
      const body = await request.json() as { reusable: boolean; expiration: string };
      expect(body.reusable).toBe(false);
      expect(Date.parse(body.expiration) - Date.now()).toBeGreaterThan(3_590_000);
      return HttpResponse.json({ preAuthKey: { key: 'tskey-2', expiration: body.expiration } });
    }));
    expect((await service().createPreAuthKey('u1')).key).toBe('tskey-2');
    server.use(http.post(`${BASE}/api/v1/preauthkey`, () => new HttpResponse('denied', { status: 403 })));
    await expect(service().createPreAuthKey('u1')).rejects.toThrow('Failed to create Headscale pre-auth key: HTTP 403 denied');
  });

  it('revokes a machine, and says why it could not', async () => {
    let removed = '';
    server.use(http.delete(`${BASE}/api/v1/node/:id`, ({ params }) => { removed = String(params.id); return HttpResponse.json({}); }));
    await service().revokeDevice('12');
    expect(removed).toBe('12');
    server.use(http.delete(`${BASE}/api/v1/node/:id`, () => new HttpResponse('gone', { status: 404 })));
    await expect(service().revokeDevice('13')).rejects.toThrow('Failed to revoke Headscale node 13: HTTP 404 gone');
  });

  it('takes a machine off the mesh by its address, and leaves the others', async () => {
    const removed: string[] = [];
    server.use(knowsUser('platform-u1'), http.get(`${BASE}/api/v1/node`, () => HttpResponse.json({ nodes: [{ id: '1', name: 'a', ipAddresses: ['100.64.0.2'] }, { id: '2', name: 'b', ipAddresses: ['100.64.0.3'] }] })), http.delete(`${BASE}/api/v1/node/:id`, ({ params }) => { removed.push(String(params.id)); return HttpResponse.json({}); }));
    await service().removeNode('u1', '100.64.0.3');
    await service().removeNode('u1', '100.64.9.9');
    expect(removed).toEqual(['2']);
  });

  it('removes a person\'s mesh user with all their machines, and does nothing for one it never made', async () => {
    const removed: string[] = [];
    server.use(
      knowsUser('platform-u1', '7'),
      http.get(`${BASE}/api/v1/node`, () => HttpResponse.json({ nodes: [{ id: '1' }, { id: '2' }] })),
      http.delete(`${BASE}/api/v1/node/:id`, ({ params }) => { removed.push(`node ${String(params.id)}`); return HttpResponse.json({}); }),
      http.delete(`${BASE}/api/v1/user/:id`, ({ params }) => { removed.push(`user ${String(params.id)}`); return HttpResponse.json({}); }),
    );
    expect(await service().removeUser('u1')).toEqual({ devices: 2, user: true });
    expect(removed).toEqual(['node 1', 'node 2', 'user 7']);
    expect(await service().removeUser('nobody')).toEqual({ devices: 0, user: false });
  });

  it('treats a mesh user already gone as removed but fails on any other refusal', async () => {
    server.use(knowsUser('platform-u1'), http.get(`${BASE}/api/v1/node`, () => HttpResponse.json({ nodes: [] })), http.delete(`${BASE}/api/v1/user/:id`, () => new HttpResponse(null, { status: 404 })));
    expect(await service().removeUser('u1')).toEqual({ devices: 0, user: true });
    server.use(http.delete(`${BASE}/api/v1/user/:id`, () => new HttpResponse('busy', { status: 500 })));
    await expect(service().removeUser('u1')).rejects.toThrow('Failed to delete Headscale user "platform-u1": HTTP 500 busy');
  });

  it('lists the addresses of every machine carrying a tag', async () => {
    server.use(http.get(`${BASE}/api/v1/node`, () => HttpResponse.json({ nodes: [{ ipAddresses: ['100.64.0.1', 'fd7a::1'], tags: ['tag:platform'] }, { ipAddresses: ['100.64.0.2'], tags: ['tag:pool'] }, { tags: ['tag:platform'] }] })));
    expect(await service().taggedAddresses('tag:platform')).toEqual(['100.64.0.1', 'fd7a::1']);
    server.use(http.get(`${BASE}/api/v1/node`, () => new HttpResponse(null, { status: 500 })));
    await expect(service().taggedAddresses('tag:platform')).rejects.toThrow('Failed to list Headscale nodes: HTTP 500');
  });

  it('finds the mesh address of a machine', async () => {
    server.use(http.get(`${BASE}/api/v1/node/:id`, ({ params }) => (params.id === '1' ? HttpResponse.json({ node: { ipAddresses: ['fd7a::1', '100.64.0.9'] } }) : new HttpResponse(null, { status: 404 }))));
    expect(await service().resolveDeviceMeshIp('1')).toBe('100.64.0.9');
    await expect(service().resolveDeviceMeshIp('2')).rejects.toThrow('Failed to get Headscale node 2: HTTP 404');
  });
});
