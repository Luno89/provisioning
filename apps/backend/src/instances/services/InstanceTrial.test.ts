import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { InstanceTrial, RootRefused } from './InstanceTrial.js';

const settings = { rootUrl: 'https://app.koala.dev', instanceId: 'inst-1', token: async () => 'cred' };

describe('an instance asking root about its trial', () => {
  it('asks with its credential, and asks again only after a while', async () => {
    const asked: Array<{ url: string; headers: Record<string, string> }> = [];
    let now = 0;
    const trial = new InstanceTrial(settings, (async (url: string, init: { headers: Record<string, string> }) => {
      asked.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ trialEndsAt: '2026-11-03T07:00:00.000Z' }), { status: 200 });
    }) as unknown as typeof fetch, () => now);
    expect(await trial.read()).toEqual({ trialEndsAt: '2026-11-03T07:00:00.000Z' });
    expect(asked[0]).toEqual({ url: 'https://app.koala.dev/api/instances/trial', headers: { 'x-instance-id': 'inst-1', authorization: 'Bearer cred' } });
    now = 60_000;
    await trial.read();
    expect(asked).toHaveLength(1);
    now = 11 * 60_000;
    await trial.read();
    expect(asked).toHaveLength(2);
  });

  it('has no trial when it is not on Koala\'s servers, and says so when root refuses', async () => {
    const none = new InstanceTrial(settings, (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch);
    expect(await none.read()).toEqual({});
    const refused = new InstanceTrial(settings, (async () => new Response(JSON.stringify({ error: 'unknown instance or credential' }), { status: 401 })) as unknown as typeof fetch);
    await expect(refused.read()).rejects.toThrow('root did not answer about this instance\'s trial (401): unknown instance or credential');
  });
});

describe('an instance moving to its own machine through root', () => {
  const calls: { method: string; url: string; authorization: string | null }[] = [];
  let answer: () => Response = () => HttpResponse.json({});
  const server = interceptHttp(http.all('https://app.koala.dev/api/instances/move/self', ({ request }) => {
    calls.push({ method: request.method, url: request.url, authorization: request.headers.get('authorization') });
    return answer();
  }));
  const trial = () => {
    calls.length = 0;
    return new InstanceTrial(settings);
  };

  it('asks root for the install command and when it stops working', async () => {
    answer = () => HttpResponse.json({ command: 'curl -fsSL https://app.koala.dev/machine.sh | sh -s -- code', expiresAt: '2026-11-03T07:00:00.000Z', extra: 1 });
    expect(await trial().startMove()).toEqual({ command: 'curl -fsSL https://app.koala.dev/machine.sh | sh -s -- code', expiresAt: '2026-11-03T07:00:00.000Z' });
    expect(calls).toEqual([{ method: 'POST', url: 'https://app.koala.dev/api/instances/move/self', authorization: 'Bearer cred' }]);
  });

  it('reads how far the move has got, or nothing when none is under way', async () => {
    answer = () => HttpResponse.json({ move: { state: 'copying', startedAt: '2026-11-01T00:00:00.000Z' } });
    expect(await trial().moveState()).toEqual({ state: 'copying', startedAt: '2026-11-01T00:00:00.000Z' });
    answer = () => HttpResponse.json({ move: null });
    expect(await trial().moveState()).toBeNull();
  });

  it('stops the move', async () => {
    answer = () => HttpResponse.json({});
    await trial().stopMove();
    expect(calls).toEqual([{ method: 'DELETE', url: 'https://app.koala.dev/api/instances/move/self', authorization: 'Bearer cred' }]);
  });

  it('passes on root\'s refusal with its status and its words', async () => {
    answer = () => HttpResponse.json({ error: 'a move is already under way' }, { status: 409 });
    const refusal = await trial().startMove().catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(RootRefused);
    expect(refusal).toMatchObject({ status: 409, message: 'a move is already under way' });
  });

  it('says only the status when root gives no reason', async () => {
    answer = () => new HttpResponse('', { status: 500 });
    await expect(trial().stopMove()).rejects.toMatchObject({ status: 500, message: 'root answered 500' });
  });

  it('reads the trial through the real fetch and the real clock when given neither', async () => {
    server.use(http.get('https://app.koala.dev/api/instances/trial', () => HttpResponse.json({ trialEndsAt: '2026-11-03T07:00:00.000Z' })));
    const fresh = trial();
    expect(await fresh.read()).toEqual({ trialEndsAt: '2026-11-03T07:00:00.000Z' });
    server.use(http.get('https://app.koala.dev/api/instances/trial', () => new HttpResponse('', { status: 500 })));
    expect(await fresh.read()).toEqual({ trialEndsAt: '2026-11-03T07:00:00.000Z' });
  });
});
