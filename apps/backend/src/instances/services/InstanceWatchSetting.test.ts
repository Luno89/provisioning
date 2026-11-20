import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { interceptHttp } from '../../platform/testing/http.js';
import { InstanceWatchSetting } from './InstanceWatchSetting.js';
import { RootRefused } from './InstanceWatchSetting.js';

interface Seen { method: string; instance: string | null; authorization: string | null; body: unknown }

let seen: Seen[] = [];
let answer: () => Response = () => HttpResponse.json({ notifyWhenUnreachable: true });

interceptHttp(http.all('https://app.koala.dev/api/instances/watch', async ({ request }) => {
  seen.push({
    method: request.method,
    instance: request.headers.get('x-instance-id'),
    authorization: request.headers.get('authorization'),
    body: request.method === 'PUT' ? await request.json() : undefined,
  });
  return answer();
}));

const setting = () => {
  seen = [];
  return new InstanceWatchSetting({ rootUrl: 'https://app.koala.dev', instanceId: 'inst-1', token: async () => 'service-token' });
};

describe('an instance asking root whether to be told when it cannot be reached', () => {
  it('reads the setting from root as itself', async () => {
    answer = () => HttpResponse.json({ notifyWhenUnreachable: true, reach: { since: '2026-11-01T00:00:00.000Z' }, extra: 'ignored' });
    expect(await setting().read()).toEqual({ notifyWhenUnreachable: true, reach: { since: '2026-11-01T00:00:00.000Z' } });
    expect(seen).toEqual([{ method: 'GET', instance: 'inst-1', authorization: 'Bearer service-token', body: undefined }]);
  });

  it('leaves out the reach when root has none to report', async () => {
    answer = () => HttpResponse.json({ notifyWhenUnreachable: false });
    expect(await setting().read()).toEqual({ notifyWhenUnreachable: false });
  });

  it('sends the new choice to root and returns what root now holds', async () => {
    answer = () => HttpResponse.json({ notifyWhenUnreachable: false });
    expect(await setting().set(false)).toEqual({ notifyWhenUnreachable: false });
    expect(seen).toEqual([{ method: 'PUT', instance: 'inst-1', authorization: 'Bearer service-token', body: { notifyWhenUnreachable: false } }]);
  });

  it('passes root\'s refusal on in root\'s own words', async () => {
    answer = () => HttpResponse.json({ error: 'unknown instance or credential' }, { status: 401 });
    const refusal = await setting().set(false).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(RootRefused);
    expect(refusal).toMatchObject({ status: 401, message: 'unknown instance or credential' });
  });

  it('says only the status when root gives no reason', async () => {
    answer = () => new HttpResponse('', { status: 502 });
    await expect(setting().read()).rejects.toThrow('root answered 502');
  });
});
