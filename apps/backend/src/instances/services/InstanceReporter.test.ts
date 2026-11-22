import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { reopening } from '@koala/engine-core/reopening';
import { interceptHttp } from '../../platform/testing/http.js';
import { InstanceReporter } from './InstanceReporter.js';

const ROOT = 'https://root.example.test';
const heard: Array<{ headers: Record<string, string | null>; body: unknown }> = [];
let answers: Array<() => Response> = [];
const removalAsked: Array<Record<string, string | null>> = [];
let removing = false;
let setupAsked: { asked: boolean; at?: string } = { asked: false };

interceptHttp(
  http.get(`${ROOT}/api/instances/setup-again`, ({ request }) => {
    removalAsked.push({ instance: request.headers.get('x-instance-id'), authorization: request.headers.get('authorization') });
    return HttpResponse.json(setupAsked);
  }),
  http.get(`${ROOT}/api/instances/owner-removal`, ({ request }) => {
    removalAsked.push({ instance: request.headers.get('x-instance-id'), authorization: request.headers.get('authorization') });
    return HttpResponse.json({ removing });
  }),
  http.put(`${ROOT}/api/instances/owner-removal`, async ({ request }) => {
    heard.push({ headers: { instance: request.headers.get('x-instance-id'), authorization: request.headers.get('authorization') }, body: await request.json() });
    return HttpResponse.json({});
  }),
  http.post(`${ROOT}/api/instances/status`, async ({ request }) => {
    heard.push({ headers: { instance: request.headers.get('x-instance-id'), authorization: request.headers.get('authorization') }, body: await request.json() });
    const next = answers.shift();
    return next ? next() : HttpResponse.json({ status: 'installing' });
  }),
);

const reporter = (said: string[] = []) => new InstanceReporter({ root: { url: ROOT, instanceId: 'inst-bo', token: async () => 'service-token' }, wait: reopening(1), log: (line) => said.push(line) });

describe('the instance telling root about itself', () => {
  it('reports its status as itself, present, with what it runs and the revision it is', async () => {
    heard.length = 0;
    answers = [];
    expect(await reporter().status({ status: 'installing', detail: 'Upgraded to v8', imageTag: 'v8', dataVersion: 2, revision: 4 })).toEqual({ ok: true });
    expect(heard).toEqual([{ headers: { instance: 'inst-bo', authorization: 'Bearer service-token' }, body: { status: 'installing', detail: 'Upgraded to v8', imageTag: 'v8', dataVersion: 2, revision: 4, presence: true } }]);
  });

  it('reports each line of its setup as only that', async () => {
    heard.length = 0;
    answers = [];
    const line = { revision: 4, progress: { stage: 'gitea', title: 'Gitea', state: 'started' as const, line: 'waiting for statefulset/gitea' } };
    expect(await reporter().setup(line)).toEqual({ ok: true });
    expect(heard.map((entry) => entry.body)).toEqual([{ provision: line }]);
  });

  it('waits for a root that is not answering, saying so, and passes on what root refused', async () => {
    heard.length = 0;
    answers = [() => new HttpResponse(null, { status: 503 }), () => HttpResponse.json({ error: 'status is one of waiting, joined' }, { status: 400 })];
    const said: string[] = [];
    expect(await reporter(said).status({ status: 'failed', detail: 'no' })).toEqual({ ok: false, status: 400, error: 'status is one of waiting, joined' });
    expect(heard).toHaveLength(2);
    expect(said).toEqual([expect.stringMatching(/^root isn't answering when this instance tells it it is failed \(.*\); asking again in 0 s$/)]);
  });

  it('tells root how the removal of its owner stands, as only that', async () => {
    heard.length = 0;
    answers = [];
    const progress = { seq: 3, phase: 'deleting' as const, work: [], parts: { projects: { state: 'deleted' as const, left: 0, deleted: 1 } } };
    expect(await reporter().ownerRemoval(progress)).toEqual({ ok: true });
    expect(heard).toEqual([{ headers: { instance: 'inst-bo', authorization: 'Bearer service-token' }, body: { progress } }]);
  });

  it('asks root whether its owner is being removed, as itself', async () => {
    removalAsked.length = 0;
    removing = true;
    expect(await reporter().ownerRemoving()).toBe(true);
    removing = false;
    expect(await reporter().ownerRemoving()).toBe(false);
    expect(removalAsked).toEqual([{ instance: 'inst-bo', authorization: 'Bearer service-token' }, { instance: 'inst-bo', authorization: 'Bearer service-token' }]);
  });

  it('asks root whether its owner asked it to set itself up again, as itself', async () => {
    removalAsked.length = 0;
    setupAsked = { asked: true, at: '2026-11-22T18:37:00.000Z' };
    expect(await reporter().setupAsked()).toBe('2026-11-22T18:37:00.000Z');
    setupAsked = { asked: false };
    expect(await reporter().setupAsked()).toBeUndefined();
    expect(removalAsked).toEqual([{ instance: 'inst-bo', authorization: 'Bearer service-token' }, { instance: 'inst-bo', authorization: 'Bearer service-token' }]);
  });
});
