import { describe, expect, it } from 'vitest';
import { poolMonitor, poolMonitorFrom } from './PoolMonitor.js';

describe('a pool instance\'s monitoring, answered by root', () => {
  it('is on only in a pool instance that knows root and holds its credential', () => {
    expect(poolMonitorFrom({ POOL: 'true', ROOT_URL: 'https://app.koala.dev/', INSTANCE_ID: 'inst-1', INSTANCE_CREDENTIAL: 'c' })).toEqual({ rootUrl: 'https://app.koala.dev', instanceId: 'inst-1', credential: 'c' });
    expect(poolMonitorFrom({ ROOT_URL: 'https://app.koala.dev', INSTANCE_ID: 'inst-1', INSTANCE_CREDENTIAL: 'c' })).toBeUndefined();
    expect(poolMonitorFrom({ POOL: 'true', ROOT_URL: 'https://app.koala.dev', INSTANCE_ID: 'inst-1' })).toBeUndefined();
  });

  it('sends root a named question with its credential, and says why root refused', async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const answers = [new Response(JSON.stringify({ samples: [{ metric: {}, value: 1 }] })), new Response(JSON.stringify({ error: 'this instance is stopped' }), { status: 409 })];
    const monitor = poolMonitor({ rootUrl: 'https://app.koala.dev', instanceId: 'inst-1', credential: 'c' }, (async (url: string, init: RequestInit) => { sent.push({ url, init }); return answers.shift()!; }) as unknown as typeof fetch);
    expect(await monitor.ask({ kind: 'cluster', question: 'nodes' })).toEqual([{ metric: {}, value: 1 }]);
    expect(sent[0]!.url).toBe('https://app.koala.dev/api/instances/monitoring/ask');
    expect(sent[0]!.init.headers).toMatchObject({ 'x-instance-id': 'inst-1', authorization: 'Bearer c' });
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ ask: { kind: 'cluster', question: 'nodes' } });
    await expect(monitor.alerts()).rejects.toThrow('root answered 409: this instance is stopped');
  });
});
