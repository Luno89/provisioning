import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { interceptHttp } from '../../platform/testing/http.js';
import { RootMeshKeys } from './RootMeshKeys.js';

interface Seen { method: string; instance: string | null; auth: string | null; body: unknown }

const seen: Seen[] = [];
let removal: () => Response = () => HttpResponse.json({});

const server = interceptHttp(
  http.post('https://app.example.com/api/instances/machine-key', async ({ request }) => {
    seen.push({ method: request.method, instance: request.headers.get('x-instance-id'), auth: request.headers.get('authorization'), body: await request.json() });
    if (request.headers.get('authorization') !== 'Bearer right') return HttpResponse.json({ error: 'unknown instance or credential' }, { status: 401 });
    return HttpResponse.json({ preAuthKey: 'key-1', meshLoginServer: 'https://mesh.example.com' });
  }),
  http.delete('https://app.example.com/api/instances/machine-node', async ({ request }) => {
    seen.push({ method: request.method, instance: request.headers.get('x-instance-id'), auth: request.headers.get('authorization'), body: await request.json() });
    return removal();
  }),
);

const keys = (token = 'right') => new RootMeshKeys({ rootUrl: 'https://app.example.com', instanceId: 'inst-1', token: async () => token });

describe('an instance asking root for a machine\'s mesh key', () => {
  it('asks as itself and hands back the key', async () => {
    expect(await keys().createPreAuthKey('owner')).toEqual({ key: 'key-1' });
    expect(seen.at(-1)).toEqual({ method: 'POST', instance: 'inst-1', auth: 'Bearer right', body: {} });
  });

  it('says why when root refuses', async () => {
    await expect(keys('wrong').createPreAuthKey('owner')).rejects.toThrow('root would not let a machine join the mesh (401): unknown instance or credential');
  });

  it('says so when root answers without a key', async () => {
    seen.length = 0;
    server.use(http.post('https://app.example.com/api/instances/machine-key', () => HttpResponse.json({ preAuthKey: 7 })));
    await expect(keys().createPreAuthKey('owner')).rejects.toThrow('root would not let a machine join the mesh (200): no key came back');
  });
});

describe('an instance asking root to take a machine off the mesh', () => {
  it('names the machine by its mesh address, as itself', async () => {
    removal = () => HttpResponse.json({ removed: true });
    await keys().removeNode('owner', '100.64.0.9');
    expect(seen.at(-1)).toEqual({ method: 'DELETE', instance: 'inst-1', auth: 'Bearer right', body: { meshIp: '100.64.0.9' } });
  });

  it('counts a machine root has never heard of as already gone', async () => {
    removal = () => HttpResponse.json({ error: 'no such node' }, { status: 404 });
    await expect(keys().removeNode('owner', '100.64.0.9')).resolves.toBeUndefined();
  });

  it('says why when root refuses', async () => {
    removal = () => HttpResponse.json({ error: 'not your machine' }, { status: 403 });
    await expect(keys().removeNode('owner', '100.64.0.9')).rejects.toThrow('root would not take the machine off the mesh (403): not your machine');
  });
});
