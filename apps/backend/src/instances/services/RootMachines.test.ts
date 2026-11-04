import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { interceptHttp } from '../../platform/testing/http.js';
import { RootMachines } from './RootMachines.js';

interface Seen { method: string; path: string; instance: string | null; auth: string | null }

const seen: Seen[] = [];
const ROOT = 'https://app.example.com/api/instances/machines';
const machine = { id: 'm-1', ownerId: 'owner', name: 'desk', rootDir: '/home/me/koala', createdAt: '2026-11-04T00:00:00Z' };
const record = (request: Request) => seen.push({ method: request.method, path: new URL(request.url).pathname, instance: request.headers.get('x-instance-id'), auth: request.headers.get('authorization') });
const refused = (request: Request) => request.headers.get('authorization') !== 'Bearer right';

interceptHttp(
  http.get(ROOT, ({ request }) => {
    record(request);
    return refused(request) ? HttpResponse.json({ error: 'unknown instance or credential' }, { status: 401 }) : HttpResponse.json([machine]);
  }),
  http.post(`${ROOT}/join-code`, ({ request }) => {
    record(request);
    return HttpResponse.json({ code: 'c', command: 'curl -fsSL https://app.example.com/machine.sh | sh -s -- c', expiresAt: 'then' }, { status: 201 });
  }),
  http.post(`${ROOT}/adopt`, async ({ request }) => {
    record(request);
    const { machines } = await request.json() as { machines: unknown[] };
    return HttpResponse.json({ adopted: machines.length });
  }),
  http.delete(`${ROOT}/:id`, ({ request, params }) => {
    record(request);
    return params.id === 'm-1' ? HttpResponse.json({ success: true }) : HttpResponse.json({ error: 'no such machine' }, { status: 404 });
  }),
);

const machines = (token = 'right') => new RootMachines({ rootUrl: 'https://app.example.com', instanceId: 'inst-1', token: async () => token });

describe('an instance asking root about its owner\'s machines', () => {
  it('lists them, makes the command and removes one, each as itself', async () => {
    seen.length = 0;
    expect(await machines().list()).toEqual([machine]);
    expect(await machines().createJoinCode('ignored')).toEqual({ code: 'c', command: 'curl -fsSL https://app.example.com/machine.sh | sh -s -- c', expiresAt: 'then' });
    expect(await machines().remove('ignored', 'm-1')).toBe(true);
    expect(seen).toEqual([
      { method: 'GET', path: '/api/instances/machines', instance: 'inst-1', auth: 'Bearer right' },
      { method: 'POST', path: '/api/instances/machines/join-code', instance: 'inst-1', auth: 'Bearer right' },
      { method: 'DELETE', path: '/api/instances/machines/m-1', instance: 'inst-1', auth: 'Bearer right' },
    ]);
  });

  it('hands root the machines it had from before, as itself', async () => {
    seen.length = 0;
    expect(await machines().adopt([machine, { ...machine, id: 'm-2' }])).toEqual({ adopted: 2 });
    expect(seen).toEqual([{ method: 'POST', path: '/api/instances/machines/adopt', instance: 'inst-1', auth: 'Bearer right' }]);
  });

  it('answers false for a machine root does not have, and says why root refused', async () => {
    expect(await machines().remove('ignored', 'gone')).toBe(false);
    await expect(machines('wrong').list()).rejects.toThrow('root would not list this instance owner\'s machines (401): unknown instance or credential');
  });
});
