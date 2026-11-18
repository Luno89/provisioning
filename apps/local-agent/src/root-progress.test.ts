import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JOIN_PROGRESS, JOIN_PROGRESS_PATH } from '@koala/engine-core/machine-join';
import { KOALA_INSTALL_PROGRESS, koalaInstallProgressPath } from '@koala/engine-core/koala-install';
import { PROGRESS_LIMITS, progressCredential, progressOf } from '@koala/engine-core/machine-progress';
import { machineProgressContract } from '@koala/engine-core/testing/machine-progress';
import { runSteps, StepFailed, type Step } from '@koala/provision';
import { rootProgress, rootReporter, rootUrlOf } from './root-progress.js';

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
  const read = progressOf(body, JOIN_PROGRESS);
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

machineProgressContract('the stand-in for root in these tests', JOIN_PROGRESS, async () => ({
  credential: async () => CODE,
  post: async (code, body) => (await fetch(`${ROOT}${JOIN_PROGRESS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(code === undefined ? {} : progressCredential(code)) },
    body: JSON.stringify(body),
  })).status,
}));

const noPause = { pause: async () => undefined };
const reporterFor = (code = CODE) => rootReporter(rootProgress(rootUrlOf(`${ROOT}/`, JOIN_PROGRESS_PATH), code, fetch, noPause));

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
    for (const { body } of heard) expect(progressOf(body, JOIN_PROGRESS).ok).toBe(true);
  });

  it('never sends what a step printed, which may hold secrets', async () => {
    await runSteps(steps, { made: new Set() }, reporterFor()).catch((err: unknown) => err);
    expect(JSON.stringify(heard)).not.toContain('hskey-secret-tail');
    expect(heard.map(({ body }) => (body as { state: string }).state)).toEqual(['started', 'done', 'started', 'failed']);
  });

  it('shortens a failure longer than root takes, so root still hears where and why it stopped', async () => {
    const long = { id: 'k3s', title: 'Installing k3s', check: async () => ({ done: false, why: 'not there' }), apply: async () => { throw new Error('x'.repeat(PROGRESS_LIMITS.why + 50)); } } satisfies Step<{ made: Set<string> }>;
    await expect(runSteps([long], { made: new Set() }, reporterFor())).rejects.toBeInstanceOf(StepFailed);
    const failure = heard.at(-1)!.body as { state: string; why: string };
    expect(failure.state).toBe('failed');
    expect(failure.why).toHaveLength(PROGRESS_LIMITS.why);
    expect(progressOf(failure, JOIN_PROGRESS).ok).toBe(true);
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

describe('telling root how putting Koala on this machine goes', () => {
  const INSTALL = 'install-7';
  const installUrl = `${ROOT}${koalaInstallProgressPath(INSTALL)}`;
  const installHeard: unknown[] = [];
  const installing: Step<{ ready: boolean }>[] = [{
    id: 'koala',
    title: 'Putting Koala on this machine',
    check: async (ctx) => (ctx.ready ? { done: true } : { done: false, why: 'not installed' }),
    apply: async (ctx, progress) => {
      progress.line('deployment/instance-backend has 0 of 1 available');
      progress.line('job/instance-seed-2 runs');
      ctx.ready = true;
    },
  }];

  it('says what each stage waits on, in order, and where Koala answers once its last stage is done', async () => {
    server.use(http.post(installUrl, async ({ request }) => {
      const body: unknown = await request.json();
      installHeard.push(body);
      const read = progressOf(body, KOALA_INSTALL_PROGRESS);
      return read.ok ? new HttpResponse(null, { status: 204 }) : new HttpResponse(read.problem, { status: 400 });
    }));
    await runSteps(installing, { ready: false }, rootReporter(rootProgress(installUrl, 'device-token', fetch, noPause), { lines: true, ending: { stage: 'koala', url: 'https://bo.koala.app' } }));
    expect(installHeard).toEqual([
      { stage: 'koala', title: 'Putting Koala on this machine', state: 'started' },
      { stage: 'koala', title: 'Putting Koala on this machine', state: 'started', line: 'deployment/instance-backend has 0 of 1 available' },
      { stage: 'koala', title: 'Putting Koala on this machine', state: 'started', line: 'job/instance-seed-2 runs' },
      { stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: 'https://bo.koala.app' },
    ]);
  });

  it('stops the install at its next stage when root refused a line, rather than going on unheard', async () => {
    server.use(http.post(installUrl, async ({ request }) => {
      const body = await request.json() as { line?: string };
      return body.line ? new HttpResponse('no such install', { status: 404 }) : new HttpResponse(null, { status: 204 });
    }));
    await expect(runSteps(installing, { ready: false }, rootReporter(rootProgress(installUrl, 'device-token', fetch, noPause), { lines: true, ending: { stage: 'koala', url: 'https://bo.koala.app' } })))
      .rejects.toThrow('root did not take this machine\'s progress (404): no such install');
  });
});
