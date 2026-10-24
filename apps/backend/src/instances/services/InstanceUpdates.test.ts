import { describe, expect, it } from 'vitest';
import { InstanceUpdates, UpdatesRefused } from './InstanceUpdates.js';

const view = (over: Record<string, unknown> = {}) => ({ auto: true, running: 'a1', current: 'b2', target: 'b2', releases: [], ...over });

const rig = (answer: { status?: number; body: unknown }, jobs: { name: string; active?: number }[] = []) => {
  const calls: { url: string; method: string; body?: string; headers: Record<string, string> }[] = [];
  const kubectl: string[][] = [];
  const updates = new InstanceUpdates(
    { rootUrl: 'https://root', instanceId: 'inst-1', credential: 'secret', cronJob: 'instance-self-upgrade', namespace: 'koala' },
    async (args) => {
      kubectl.push(args);
      return args[0] === 'get' ? JSON.stringify({ items: jobs.map((job) => ({ metadata: { name: job.name }, status: { active: job.active ?? 0 } })) }) : '';
    },
    (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), ...(init.body ? { body: String(init.body) } : {}), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
    }) as typeof fetch,
    () => new Date(1_800_000_000_000),
  );
  return { updates, calls, kubectl };
};

describe('an instance\'s updates, kept on root', () => {
  it('asks root as itself, and says when a check-in is already running', async () => {
    const { updates, calls } = rig({ body: view() }, [{ name: 'instance-self-upgrade-29000000', active: 1 }, { name: 'other', active: 1 }]);
    expect(await updates.view()).toMatchObject({ target: 'b2', checking: 'instance-self-upgrade-29000000' });
    expect(calls[0]).toMatchObject({ url: 'https://root/api/instances/updates', method: 'GET', headers: { 'x-instance-id': 'inst-1', authorization: 'Bearer secret' } });
  });

  it('starts the check-in at once when the change moves it, and only one', async () => {
    const moving = rig({ body: view({ auto: false, picked: 'b2' }) });
    expect(await moving.updates.set({ version: 'v2' })).toMatchObject({ checking: 'instance-self-upgrade-mywpiww0' });
    expect(moving.calls[0]).toMatchObject({ method: 'PUT', body: '{"version":"v2"}' });
    expect(moving.kubectl.at(-1)).toEqual(['create', 'job', '--from=cronjob/instance-self-upgrade', 'instance-self-upgrade-mywpiww0', '-n', 'koala']);

    const busy = rig({ body: view() }, [{ name: 'instance-self-upgrade-earlier', active: 1 }]);
    expect(await busy.updates.set({ auto: true })).toMatchObject({ checking: 'instance-self-upgrade-earlier' });
    expect(busy.kubectl.some((args) => args[0] === 'create')).toBe(false);

    const staying = rig({ body: view({ auto: false, picked: 'a1', target: 'a1' }) });
    expect(await staying.updates.set({ auto: false })).not.toHaveProperty('checking');
    expect(staying.kubectl).toEqual([]);
  });

  it('passes root\'s refusal on in its own words', async () => {
    const { updates } = rig({ status: 409, body: { error: 'v1 is older than what this instance runs' } });
    await expect(updates.set({ version: 'v1' })).rejects.toEqual(new UpdatesRefused(409, 'v1 is older than what this instance runs'));
  });
});
