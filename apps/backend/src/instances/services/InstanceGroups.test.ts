import { describe, expect, it } from 'vitest';
import { InstanceGroups } from './InstanceGroups.js';

function rootAnswering(answers: { status: number; body: object }[]) {
  const asked: Array<{ url: string; method: string; body?: string | undefined; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    asked.push({ url, method: String(init.method), body: init.body as string | undefined, headers: init.headers as Record<string, string> });
    const next = answers.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

describe('an instance asking root for the groups of its shared projects', () => {
  it('checks, claims and frees a group as the instance, and gives root\'s reason when it refuses', async () => {
    const { asked, fetchImpl } = rootAnswering([
      { status: 200, body: { ok: false, problem: '"acme" is taken' } },
      { status: 200, body: { ok: true } },
      { status: 409, body: { error: '"acme" is taken' } },
      { status: 200, body: { projectId: 'p1', name: 'globex' } },
      { status: 200, body: { released: true } },
    ]);
    const groups = new InstanceGroups({ rootUrl: 'https://root', instanceId: 'inst-1', credential: 'secret' }, fetchImpl);
    expect(await groups.check('acme')).toBe('"acme" is taken');
    expect(await groups.check('globex')).toBeNull();
    await expect(groups.claim('p1', 'acme')).rejects.toThrow('"acme" is taken');
    await groups.claim('p1', 'globex');
    await groups.release('p1');
    expect(asked.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'GET https://root/api/instances/groups/check?name=acme',
      'GET https://root/api/instances/groups/check?name=globex',
      'PUT https://root/api/instances/groups',
      'PUT https://root/api/instances/groups',
      'DELETE https://root/api/instances/groups/p1',
    ]);
    expect(asked[3]).toMatchObject({ body: '{"projectId":"p1","name":"globex"}', headers: { 'x-instance-id': 'inst-1', authorization: 'Bearer secret' } });
  });
});
