import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { instanceWatchRouter } from './instance-watch.js';
import { InstanceWatchSetting } from '../services/InstanceWatchSetting.js';
import { RootRefused } from '../services/InstanceTrial.js';

let harness: Harness | undefined;
afterEach(async () => harness?.close());

describe('whether root emails the instance\'s owner when it cannot be reached', () => {
  it('is read from root and switched only by the instance\'s owner', async () => {
    const asked: Array<{ method: string; url: string; body?: string; credential: string | undefined }> = [];
    let on = true;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      asked.push({ method: init?.method ?? 'GET', url, ...(typeof init?.body === 'string' ? { body: init.body } : {}), credential: (init?.headers as Record<string, string>).authorization });
      if (init?.method === 'PUT') on = (JSON.parse(String(init.body)) as { notifyWhenUnreachable: boolean }).notifyWhenUnreachable;
      return new Response(JSON.stringify({ notifyWhenUnreachable: on, alwaysTold: false }), { status: 200 });
    }) as typeof fetch;
    const setting = new InstanceWatchSetting({ rootUrl: 'https://app.koala.dev', instanceId: 'inst-a', token: async () => 'cred' }, fetchImpl);
    harness = await mountRouter({ prefix: '/api/instance-watch', claims: { role: 'instance', instanceOwnerId: TEST_USER.id }, router: () => instanceWatchRouter({ setting }) });
    expect((await axios.get(harness.url('/api/instance-watch'))).data).toEqual({ notifyWhenUnreachable: true, alwaysTold: false });
    expect((await axios.put(harness.url('/api/instance-watch'), { notifyWhenUnreachable: false })).data).toEqual({ notifyWhenUnreachable: false, alwaysTold: false });
    expect((await axios.put(harness.url('/api/instance-watch'), { notifyWhenUnreachable: 'no' }, { validateStatus: () => true })).status).toBe(400);
    expect(asked.map((call) => `${call.method} ${call.url} ${call.credential}`)).toEqual([
      'GET https://app.koala.dev/api/instances/watch Bearer cred',
      'PUT https://app.koala.dev/api/instances/watch Bearer cred',
    ]);
    await harness.close();

    harness = await mountRouter({ prefix: '/api/instance-watch', claims: { role: 'instance', instanceOwnerId: 'someone-else' }, router: () => instanceWatchRouter({ setting }) });
    expect((await axios.put(harness.url('/api/instance-watch'), { notifyWhenUnreachable: true }, { validateStatus: () => true })).status).toBe(403);
    expect(asked).toHaveLength(2);
  });

  it('passes root\'s refusal on, and says so where nothing is watched', async () => {
    const refusing = { read: async () => { throw new RootRefused(409, 'an instance on Koala\'s servers always tells its owner when it cannot be reached'); }, set: async () => { throw new RootRefused(409, 'no'); } };
    harness = await mountRouter({ prefix: '/api/instance-watch', claims: { role: 'instance', instanceOwnerId: TEST_USER.id }, router: () => instanceWatchRouter({ setting: refusing }) });
    const answer = await axios.get(harness.url('/api/instance-watch'), { validateStatus: () => true });
    expect([answer.status, answer.data.error]).toEqual([409, 'an instance on Koala\'s servers always tells its owner when it cannot be reached']);
    await harness.close();
    harness = await mountRouter({ prefix: '/api/instance-watch', router: () => instanceWatchRouter({ setting: undefined }) });
    expect((await axios.get(harness.url('/api/instance-watch'), { validateStatus: () => true })).status).toBe(404);
  });
});
