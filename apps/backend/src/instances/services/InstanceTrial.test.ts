import { describe, expect, it } from 'vitest';
import { InstanceTrial } from './InstanceTrial.js';

const settings = { rootUrl: 'https://app.koala.dev', instanceId: 'inst-1', credential: 'cred' };

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
