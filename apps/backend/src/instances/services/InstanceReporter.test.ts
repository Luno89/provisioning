import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { reopening } from '@koala/engine-core/reopening';
import { interceptHttp } from '../../platform/testing/http.js';
import { InstanceReporter } from './InstanceReporter.js';

const ROOT = 'https://root.example.test';
const heard: Array<{ headers: Record<string, string | null>; body: unknown }> = [];
let answers: Array<() => Response> = [];

interceptHttp(
  http.post(`${ROOT}/api/instances/status`, async ({ request }) => {
    heard.push({ headers: { instance: request.headers.get('x-instance-id'), authorization: request.headers.get('authorization') }, body: await request.json() });
    const next = answers.shift();
    return next ? next() : HttpResponse.json({ status: 'installing' });
  }),
);

const reporter = (said: string[] = []) => new InstanceReporter({ root: { url: ROOT, instanceId: 'inst-bo', credential: 'secret' }, wait: reopening(1), log: (line) => said.push(line) });

describe('the instance telling root about itself', () => {
  it('reports its status as itself, present, with what it runs and the revision it is', async () => {
    heard.length = 0;
    answers = [];
    expect(await reporter().status({ status: 'installing', detail: 'Upgraded to v8', imageTag: 'v8', dataVersion: 2, revision: 4 })).toEqual({ ok: true });
    expect(heard).toEqual([{ headers: { instance: 'inst-bo', authorization: 'Bearer secret' }, body: { status: 'installing', detail: 'Upgraded to v8', imageTag: 'v8', dataVersion: 2, revision: 4, presence: true } }]);
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
});
