import { anyOf } from '../../platform/lib/test-matchers.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { PushError, PushService } from './PushService.js';
import { vapidKeysFrom } from '../lib/web-push.js';

const browser = (n: number) => ({ endpoint: `https://push.example/send/${n}`, keys: { p256dh: `key${n}`, auth: `auth${n}` } });
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36';

let db: MongoDB;
let sent: Array<{ endpoint: string; payload: string }>;
let failing: Map<string, number>;
let service: PushService;

beforeEach(async () => {
  db = await testDatabase();
  await db.monitoring.ensureIndexes();
  sent = [];
  failing = new Map();
  service = new PushService({
    store: db.monitoring,
    vapid: vapidKeysFrom('k'.repeat(64)),
    send: async (subscription, payload) => {
      const status = failing.get(subscription.endpoint);
      if (status) throw Object.assign(new Error(`push service answered ${status}`), { statusCode: status });
      sent.push({ endpoint: subscription.endpoint, payload });
    },
    now: () => '2026-10-29T10:00:00.000Z',
    log: () => undefined,
  });
});

describe('a person\'s devices', () => {
  it('are added once per browser, listed with the instance\'s public key, and removed only by their owner', async () => {
    const view = await service.subscribe('alice', browser(1), CHROME);
    expect(view.publicKey).toBe(vapidKeysFrom('k'.repeat(64)).publicKey);
    expect(view.devices).toEqual([{ id: anyOf(String), label: 'Chrome on Linux', endpoint: browser(1).endpoint, createdAt: '2026-10-29T10:00:00.000Z' }]);
    expect((await service.subscribe('alice', browser(1), CHROME)).devices).toHaveLength(1);
    expect((await service.subscribe('alice', browser(2), undefined)).devices).toHaveLength(2);
    expect((await service.view('bob')).devices).toEqual([]);
    const id = view.devices[0]!.id;
    await expect(service.remove('bob', id)).rejects.toMatchObject({ status: 404 });
    expect((await service.remove('alice', id)).devices.map((device) => device.label)).toEqual(['A browser on a device']);
    await expect(service.subscribe('alice', { endpoint: 'http://push.example/x' }, CHROME)).rejects.toBeInstanceOf(PushError);
  });

  it('each get a push, a gone one is forgotten, and one that failed otherwise is kept', async () => {
    await service.subscribe('alice', browser(1), CHROME);
    await service.subscribe('alice', browser(2), CHROME);
    await service.subscribe('alice', browser(3), CHROME);
    failing.set(browser(2).endpoint, 410);
    failing.set(browser(3).endpoint, 503);
    expect(await service.toPerson('alice', { title: 'Alert: shop is down', body: 'no answer' })).toBe(1);
    expect(sent.map((one) => one.endpoint)).toEqual([browser(1).endpoint]);
    expect(JSON.parse(sent[0]!.payload)).toEqual({ title: 'Alert: shop is down', body: 'no answer', path: '/' });
    expect((await service.view('alice')).devices).toHaveLength(2);
  });

  it('take a test push, and say so when none is set up', async () => {
    await expect(service.test('alice')).rejects.toMatchObject({ status: 409 });
    await service.subscribe('alice', browser(1), CHROME);
    expect(await service.test('alice')).toEqual({ sent: 1 });
    expect((JSON.parse(sent[0]!.payload) as { title: string }).title).toBe('Koala can reach this device');
  });
});
