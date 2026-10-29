import { describe, expect, it } from 'vitest';
import { RootWatch, rootProbeUrl } from './RootWatch.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('an instance watching root', () => {
  it('pushes to its owner once root has not answered for the threshold, shows it down, and once when it is back', async () => {
    let minute = 0;
    let answering = true;
    const told: Array<{ to: string; title: string; tag: string }> = [];
    const probed: string[] = [];
    const watch = new RootWatch({
      rootUrl: 'https://app.koala.dev/',
      ownerId: 'owner',
      probe: async (url) => { probed.push(url); return answering; },
      tell: async (to, message) => { told.push({ to, title: message.title, tag: message.tag }); },
      afterMs: 10 * 60_000,
      now: () => new Date(Date.parse('2026-10-29T10:00:00Z') + minute * 60_000),
      log: () => undefined,
    });
    const tick = async () => { await watch.pass(); await settle(); minute += 1; };
    expect(watch.view()).toEqual({ rootUrl: 'https://app.koala.dev/', reachable: true, down: false });
    await tick();
    await tick();
    expect(watch.view()).toMatchObject({ reachable: true, down: false, lastSeenAt: expect.any(String) });
    answering = false;
    for (let i = 0; i < 11; i += 1) await tick();
    expect(watch.view()).toMatchObject({ reachable: false, down: false });
    await tick();
    expect(told).toEqual([{ to: 'owner', title: 'Koala\'s root is not answering', tag: 'koala-root' }]);
    expect(watch.view()).toMatchObject({ reachable: false, down: true, unreachableSince: expect.any(String) });
    await tick();
    expect(told).toHaveLength(1);
    answering = true;
    await tick();
    await tick();
    expect(told.map((entry) => entry.title)).toEqual(['Koala\'s root is not answering', 'Koala\'s root answers again']);
    expect(watch.view()).toMatchObject({ reachable: true, down: false });
    expect(probed[0]).toBe('https://app.koala.dev/api/identity/keys');
    expect(rootProbeUrl('https://root.example')).toBe('https://root.example/api/identity/keys');
  });
});
