import { describe, expect, it } from 'vitest';
import { InstanceWatch, answersHttp } from './InstanceWatch.js';
import type { InstanceRecord } from '../lib/instances.js';
import type { InstanceWatchRecord, Reach } from '../lib/instance-watch.js';

const own: InstanceRecord = { id: 'inst-own', ownerId: 'person', url: 'https://own.example', createdAt: '', updatedAt: '', status: 'ready', meshIp: '100.64.0.2', name: 'own' };
const pooled: InstanceRecord = { ...own, id: 'inst-pool', ownerId: 'trier', meshIp: '100.64.0.3', name: 'pooled', pool: { ports: { backend: 1, edge: 2, registry: 3 }, startedAt: '', trialEndsAt: '' } };

function harness(answering: Record<string, boolean>, watches: InstanceWatchRecord[] = []) {
  let minute = 0;
  const saved = new Map<string, Reach>(watches.filter((watch) => watch.reach).map((watch) => [watch.instanceId, watch.reach!]));
  const owners: Array<{ to: string; subject: string }> = [];
  const operators: string[] = [];
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const watch = new InstanceWatch({
    store: {
      getInstances: async () => [own, pooled, { ...own, id: 'inst-paused', status: 'paused' }],
      getWatches: async () => [...new Set([...watches.map((entry) => entry.instanceId), ...saved.keys()])].map((instanceId) => ({
        ...watches.find((entry) => entry.instanceId === instanceId), instanceId, reach: saved.get(instanceId),
      })),
      saveReach: async (instance, reach) => { saved.set(instance.id, reach); },
    },
    probe: async (url) => answering[url.split('//')[1]!.split(':')[0]!] ?? false,
    tellOwner: async (to, message) => { owners.push({ to, subject: message.subject }); },
    tellOperators: async (message) => { operators.push(message.subject); },
    afterMs: 10 * 60_000,
    now: () => new Date(Date.parse('2026-10-29T10:00:00Z') + minute * 60_000),
    log: () => undefined,
  });
  const tick = async () => { await watch.pass(); await settle(); minute += 1; };
  return { watch, tick, saved, owners, operators, answering };
}

describe('root watching every instance', () => {
  it('emails a pool instance\'s owner and the operator once after ten minutes, and once when it is back', async () => {
    const h = harness({ '100.64.0.2': true, '100.64.0.3': false });
    for (let i = 0; i < 12; i += 1) await h.tick();
    expect(h.owners.map((told) => told.to)).toEqual(['trier']);
    expect(h.owners[0]!.subject).toMatch(/^Your instance pooled \(inst-pool\) has not answered for 1\d minutes$/);
    expect(h.operators).toHaveLength(1);
    expect(h.operators[0]).toMatch(/^An instance pooled/);
    expect(h.saved.get('inst-own')?.reachable).toBe(true);
    expect(h.saved.has('inst-paused')).toBe(false);
    for (let i = 0; i < 5; i += 1) await h.tick();
    expect(h.owners).toHaveLength(1);
    h.answering['100.64.0.3'] = true;
    await h.tick();
    await h.tick();
    expect(h.owners.map((told) => told.subject)).toEqual([h.owners[0]!.subject, 'Your instance pooled (inst-pool) answers again']);
    expect(h.operators).toHaveLength(2);
    expect(h.saved.get('inst-pool')).toEqual({ reachable: true, lastSeenAt: expect.any(String) });
  });

  it('tells nobody about an own machine whose owner switched it off, but still records it', async () => {
    const h = harness({ '100.64.0.2': false, '100.64.0.3': true }, [{ instanceId: 'inst-own', notifyWhenUnreachable: false }]);
    for (let i = 0; i < 13; i += 1) await h.tick();
    expect(h.owners).toEqual([]);
    expect(h.operators).toEqual([]);
    expect(h.saved.get('inst-own')).toMatchObject({ reachable: false, toldDown: true });
  });

  it('counts a probe still waiting at the next pass as not answered, and never starts a second beside it', async () => {
    let started = 0;
    const watch = new InstanceWatch({
      store: { getInstances: async () => [own], getWatches: async () => [], saveReach: async () => undefined },
      probe: () => { started += 1; return new Promise<boolean>(() => undefined); },
      tellOwner: async () => undefined,
      tellOperators: async () => undefined,
      afterMs: 60_000,
    });
    await watch.pass();
    await watch.pass();
    await watch.pass();
    expect(started).toBe(1);
  });
});

describe('a probe', () => {
  it('counts any answer as reaching the backend, and a refused connection as not', async () => {
    expect(await answersHttp((async () => new Response('', { status: 503 })) as typeof fetch)('http://x')).toBe(true);
    expect(await answersHttp((async () => { throw new TypeError('fetch failed'); }) as typeof fetch)('http://x')).toBe(false);
  });
});
