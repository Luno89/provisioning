import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { interceptHttp } from '../../platform/testing/http.js';
import { InstanceUpdates, UpdatesRefused } from './InstanceUpdates.js';

const view = (over: Record<string, unknown> = {}) => ({ auto: true, running: 'a1', current: 'b2', target: 'b2', releases: [], ...over });

const rig = (answer: { status?: number; body: unknown }, jobs: { name: string; active?: number }[] = []) => {
  const calls: { url: string; method: string; body?: string; headers: Record<string, string> }[] = [];
  const kubectl: string[][] = [];
  const updates = new InstanceUpdates(
    { rootUrl: 'https://root', instanceId: 'inst-1', token: async () => 'secret', cronJob: 'instance-self-upgrade', namespace: 'koala' },
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

  it('asks root, as itself, what the release it runs carries', async () => {
    const answer = { release: 'v2026.10.25', findings: [{ component: { name: 'seroval', version: '1.6.7', kind: 'npm' }, advisory: { id: 'GHSA-x' }, state: 'due', fix: '1.6.8', fixedBy: 'v2026.10.29' }] };
    const { updates, calls } = rig({ body: answer });
    expect(await updates.findings()).toEqual(answer);
    expect(calls[0]).toMatchObject({ url: 'https://root/api/instances/release-findings', headers: { 'x-instance-id': 'inst-1', authorization: 'Bearer secret' } });
    await expect(rig({ status: 401, body: { error: 'unknown instance or credential' } }).updates.findings()).rejects.toBeInstanceOf(UpdatesRefused);
  });
});

describe('an instance\'s updates with the real fetch and the real clock', () => {
  const kubectlCalls: string[][] = [];
  const server = interceptHttp(
    http.put('https://root/api/instances/updates', () => HttpResponse.json(view({ auto: false, picked: 'b2' }))),
  );

  it('names the check-in it starts after the moment it is started', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1_800_000_000_000));
    try {
      const updates = new InstanceUpdates(
        { rootUrl: 'https://root', instanceId: 'inst-1', token: async () => 'secret', cronJob: 'instance-self-upgrade', namespace: 'koala' },
        async (args) => {
          kubectlCalls.push(args);
          return args[0] === 'get' ? JSON.stringify({ items: [] }) : '';
        },
      );
      expect(await updates.set({ version: 'v2' })).toMatchObject({ checking: 'instance-self-upgrade-mywpiww0' });
    } finally {
      vi.useRealTimers();
    }
    expect(kubectlCalls.at(-1)).toEqual(['create', 'job', '--from=cronjob/instance-self-upgrade', 'instance-self-upgrade-mywpiww0', '-n', 'koala']);
  });

  it('refuses to start a check-in on an instance installed without a credential from root', async () => {
    const updates = new InstanceUpdates({ rootUrl: 'https://root', instanceId: 'inst-1', token: async () => 'secret' }, async () => '');
    await expect(updates.checkNow()).rejects.toMatchObject({ status: 409 });
  });

  it('shows the updates without a running check-in when the jobs cannot be read', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      server.use(http.get('https://root/api/instances/updates', () => HttpResponse.json(view())));
      const updates = new InstanceUpdates(
        { rootUrl: 'https://root', instanceId: 'inst-1', token: async () => 'secret', cronJob: 'instance-self-upgrade', namespace: 'koala' },
        async () => { throw new Error('the cluster is not answering'); },
      );
      expect(await updates.view()).not.toHaveProperty('checking');
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('the cluster is not answering'));
    } finally {
      warned.mockRestore();
    }
  });
});
