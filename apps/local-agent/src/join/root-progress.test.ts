import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JOIN_PROGRESS_PATH, joinProgressOf } from '@koala/engine-core/join-progress';
import { joinProgressContract } from '@koala/engine-core/testing/join-progress-contract';
import { runSteps, StepFailed, type Step } from '@koala/provision';
import { rootJoinProgress, rootReporter } from './root-progress.js';

const ROOT = 'https://root.koala.test';
const CODE = 'the-join-code';
const heard: { auth: string | null; body: unknown }[] = [];
let answers: number[] = [];

const rootHearing = http.post(`${ROOT}${JOIN_PROGRESS_PATH}`, async ({ request }) => {
  const body: unknown = await request.json();
  heard.push({ auth: request.headers.get('authorization'), body });
  const forced = answers.shift();
  if (forced !== undefined) return new HttpResponse('root is restarting', { status: forced });
  if (request.headers.get('authorization') !== `Bearer ${CODE}`) return new HttpResponse('that command has expired or was already used', { status: 401 });
  const read = joinProgressOf(body);
  return read.ok ? new HttpResponse(null, { status: 204 }) : new HttpResponse(read.problem, { status: 400 });
});

const server = setupServer(rootHearing);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  heard.length = 0;
  answers = [];
});
afterAll(() => server.close());

joinProgressContract('the stand-in for root in these tests', async () => ({
  code: CODE,
  post: async (credential, body) => (await fetch(`${ROOT}${JOIN_PROGRESS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify(body),
  })).status,
}));

const noPause = { pause: async () => undefined };
const reporterFor = (code = CODE) => rootReporter(rootJoinProgress(ROOT, code, fetch, noPause));

const steps: Step<{ made: Set<string> }>[] = [
  { id: 'mesh', title: 'Joining your private network', check: async (ctx) => (ctx.made.has('mesh') ? { done: true } : { done: false, why: 'not on it' }), apply: async (ctx) => { ctx.made.add('mesh'); } },
  {
    id: 'k3s',
    title: 'Installing k3s',
    check: async () => ({ done: false, why: 'k3s is not installed' }),
    apply: async (_ctx, progress) => {
      progress.line('MESH_AUTH_KEY=hskey-secret-tail');
      throw new Error('the k3s downloaded is not the one Koala pins');
    },
  },
];

describe('telling root how a machine\'s join goes', () => {
  it('posts each stage\'s state with the join code as the credential, in the shape both sides hold to', async () => {
    const failed = await runSteps(steps, { made: new Set(['mesh']) }, reporterFor()).then(() => undefined, (err: unknown) => err);
    expect(failed).toBeInstanceOf(StepFailed);
    expect(heard).toEqual([
      { auth: `Bearer ${CODE}`, body: { stage: 'mesh', title: 'Joining your private network', state: 'started' } },
      { auth: `Bearer ${CODE}`, body: { stage: 'mesh', title: 'Joining your private network', state: 'already-done' } },
      { auth: `Bearer ${CODE}`, body: { stage: 'k3s', title: 'Installing k3s', state: 'started' } },
      { auth: `Bearer ${CODE}`, body: { stage: 'k3s', title: 'Installing k3s', state: 'failed', why: 'the k3s downloaded is not the one Koala pins' } },
    ]);
    for (const { body } of heard) expect(joinProgressOf(body).ok).toBe(true);
  });

  it('never sends what a step printed, which may hold secrets', async () => {
    await runSteps(steps, { made: new Set() }, reporterFor()).catch((err: unknown) => err);
    expect(JSON.stringify(heard)).not.toContain('hskey-secret-tail');
    expect(heard.map(({ body }) => (body as { state: string }).state)).toEqual(['started', 'done', 'started', 'failed']);
  });

  it('waits through root answering that it is down, and goes on once it hears', async () => {
    answers = [503, 502];
    await runSteps([steps[0]!], { made: new Set(['mesh']) }, reporterFor());
    expect(heard.map(({ body }) => (body as { state: string }).state)).toEqual(['started', 'started', 'started', 'already-done']);
  });

  it('stops the join, saying why, when root refuses to hear it', async () => {
    await expect(runSteps([steps[0]!], { made: new Set(['mesh']) }, reporterFor('another-code')))
      .rejects.toThrow('root did not take this machine\'s progress (401): that command has expired or was already used');
    expect(heard).toHaveLength(1);
  });

  it('stops the join when root has no place to hear it, since that will never change', async () => {
    server.use(http.post(`${ROOT}${JOIN_PROGRESS_PATH}`, () => new HttpResponse('Cannot POST', { status: 404 })));
    await expect(runSteps([steps[0]!], { made: new Set() }, reporterFor())).rejects.toThrow('root did not take this machine\'s progress (404): Cannot POST');
  });
});
