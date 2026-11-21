import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { http, HttpResponse, interceptHttp } from '../../apps/backend/src/platform/testing/http.js';
import { DEV_UP_STEP, devStackProblemOf, devStackState, devStepOf, provisioningFailed, type DevStackLooks } from './dev-stack-state.js';

const ROOT = 'http://root.test:3002';
const REPO = '/home/someone/provisioning';
const OWNER = { email: 'owner@dev.test', password: 'pw' };

let instance: unknown = { status: 'ready', detail: 'serving' };
let login: { status: number; body: string } = { status: 200, body: '{}' };
let rootUp = true;
let sentCookie: string | null = null;
let setCookie = '__Host-koala_sid=s%3Athe-session.signed; Path=/; HttpOnly';

interceptHttp(
  http.post(`${ROOT}/api/auth/login`, async ({ request }) => {
    if (!rootUp) return HttpResponse.error();
    expect(await request.json()).toEqual(OWNER);
    if (login.status !== 200) return new HttpResponse(login.body, { status: login.status });
    return new HttpResponse('{}', { status: 200, headers: { 'set-cookie': setCookie } });
  }),
  http.get(`${ROOT}/api/instances/mine`, ({ request }) => {
    sentCookie = request.headers.get('cookie');
    return HttpResponse.json({ instance });
  }),
);

const looks = (overrides: Partial<DevStackLooks> = {}): DevStackLooks => ({
  rootApi: ROOT,
  rootFrom: () => `${REPO}/apps/backend`,
  koalaFrom: async () => REPO,
  ownerSignIn: () => OWNER,
  ...overrides,
});

const fresh = () => {
  instance = { status: 'ready', detail: 'serving' };
  login = { status: 200, body: '{}' };
  rootUp = true;
  sentCookie = null;
  setCookie = '__Host-koala_sid=s%3Athe-session.signed; Path=/; HttpOnly';
};

describe('whether the dev stack is up, as root records it', () => {
  it('is up when root reports dev\'s owner\'s Koala ready and root and the Koala both run this checkout', async () => {
    fresh();
    expect(await devStackState(REPO, looks())).toEqual({ kind: 'ready' });
    expect(sentCookie).toBe('__Host-koala_sid=s%3Athe-session.signed');
  });

  it('takes no signed cookie of root\'s old kind as dev\'s owner\'s session', async () => {
    fresh();
    setCookie = '__Host-session=an-old-signed-token; Path=/; HttpOnly';
    expect(await devStackState(REPO, looks())).toEqual({ kind: 'failed', stage: 'root signed dev\'s owner in without a session cookie' });
    expect(sentCookie).toBeNull();
  });

  it('is still being provisioned while root does not answer, has no owner yet, or reports the Koala installing', async () => {
    fresh();
    rootUp = false;
    expect(await devStackState(REPO, looks())).toEqual({ kind: 'provisioning', stage: `root does not answer on ${ROOT} yet` });
    fresh();
    expect(await devStackState(REPO, looks({ ownerSignIn: () => undefined }))).toEqual({ kind: 'provisioning', stage: 'dev has not made its owner on root yet' });
    fresh();
    instance = { status: 'installing', detail: 'the instance chart is rolling out' };
    expect(await devStackState(REPO, looks())).toEqual({ kind: 'provisioning', stage: 'root has your Koala installing: the instance chart is rolling out' });
    fresh();
    login = { status: 503, body: 'Temporal is down' };
    expect(await devStackState(REPO, looks())).toEqual({ kind: 'provisioning', stage: 'root answered 503 when dev\'s owner signed in: Temporal is down' });
  });

  it('never asks the Koala\'s pods which checkout they run before root reports the Koala ready', async () => {
    fresh();
    instance = null;
    const state = await devStackState(REPO, looks({ koalaFrom: async () => { throw new Error('no deployment yet'); } }));
    expect(state).toEqual({ kind: 'provisioning', stage: 'root has your Koala waiting: waiting for this computer to put Koala on itself' });
  });

  it('has failed with root\'s reason when root reports the Koala failed, or refuses dev\'s owner', async () => {
    fresh();
    instance = { status: 'failed', detail: 'the backend pod cannot pull its image' };
    expect(await devStackState(REPO, looks())).toEqual({ kind: 'failed', stage: 'root reports putting your Koala on this computer failed: the backend pod cannot pull its image' });
    fresh();
    instance = 'not an instance';
    expect(await devStackState(REPO, looks())).toEqual({ kind: 'failed', stage: 'root\'s answer about your Koala could not be read (root\'s answer about your Koala is not one it gives: {"instance":"not an instance"}): {"instance":"not an instance"}' });
    fresh();
    login = { status: 401, body: '{"error":"Invalid credentials"}' };
    expect(await devStackState(REPO, looks())).toEqual({ kind: 'failed', stage: 'root refused dev\'s owner signing in (401): {"error":"Invalid credentials"}' });
  });

  it('is not this commit when root or the Koala\'s pods run another checkout', async () => {
    fresh();
    expect(await devStackState(REPO, looks({ rootFrom: () => '/elsewhere' }))).toEqual({ kind: 'not this checkout', why: `root on ${ROOT} runs from /elsewhere, not this checkout (${REPO}), so it is not running this commit` });
    expect(await devStackState(REPO, looks({ rootFrom: () => undefined }))).toEqual({ kind: 'not this checkout', why: `cannot tell which checkout root on ${ROOT} runs from` });
    expect(await devStackState(REPO, looks({ koalaFrom: async () => '/elsewhere' }))).toEqual({ kind: 'not this checkout', why: `your Koala's pods run /elsewhere, not this checkout (${REPO}), so they are not running this commit` });
    expect(await devStackState(REPO, looks({ koalaFrom: async () => { throw new Error('deployments.apps "instance-backend" not found'); } })))
      .toEqual({ kind: 'not this checkout', why: 'root reports your Koala ready, and its pods cannot be asked which checkout they run: deployments.apps "instance-backend" not found' });
  });
});

describe('what a run that needs the dev stack is told', () => {
  it('nothing when it is up', () => {
    expect(devStackProblemOf({ kind: 'ready' })).toBeUndefined();
  });

  it('that the dev stack is not up yet, and where it is', () => {
    expect(devStackProblemOf({ kind: 'provisioning', stage: 'root has your Koala installing: the chart' }))
      .toBe('the dev stack is not up yet (root has your Koala installing: the chart); start it with `npm run dev` from this checkout and let it finish');
  });

  it('that provisioning the dev stack failed, with root\'s reason', () => {
    expect(devStackProblemOf({ kind: 'failed', stage: 'root reports putting your Koala on this computer failed: no image' }))
      .toBe('provisioning the dev stack failed: root reports putting your Koala on this computer failed: no image');
  });

  it('that it runs another checkout', () => {
    expect(devStackProblemOf({ kind: 'not this checkout', why: 'root runs from /elsewhere' })).toBe('root runs from /elsewhere');
  });
});

describe('where provisioning the dev stack stopped', () => {
  it('names the step npm run dev was on and what root last recorded', () => {
    expect(provisioningFailed('npm run dev stopped (1)', { devStep: '[5] Root', root: { kind: 'provisioning', stage: `root does not answer on ${ROOT} yet` } }))
      .toBe(`provisioning the dev stack failed at npm run dev's step "[5] Root": npm run dev stopped (1); root does not answer on ${ROOT} yet`);
    expect(provisioningFailed('root reports putting your Koala on this computer failed: no image', { devStep: '[7] This computer joins your account as a machine, and Koala is put on it' }))
      .toBe('provisioning the dev stack failed at npm run dev\'s step "[7] This computer joins your account as a machine, and Koala is put on it": root reports putting your Koala on this computer failed: no image');
    expect(provisioningFailed('npm run setup failed (1)', {})).toBe('provisioning the dev stack failed before npm run dev started: npm run setup failed (1)');
  });

  it('reads the step npm run dev is on from its output, colours and all', () => {
    const log = '\n\x1b[1m[1] Terraform\'s providers\x1b[0m\n  ready\n\n\x1b[1m[2] Root\'s services: Temporal, Mongo\x1b[0m\n    pulling temporal\r    pulled\n';
    expect(devStepOf(log)).toBe('[2] Root\'s services: Temporal, Mongo');
    expect(devStepOf('')).toBeUndefined();
  });

  it('knows the step npm run dev says once the stack is up, as dev.sh says it', () => {
    const devScript = readFileSync(resolve(import.meta.dirname, '..', '..', 'scripts', 'dev.sh'), 'utf8');
    expect(devScript).toContain(`say "${DEV_UP_STEP}`);
  });
});
