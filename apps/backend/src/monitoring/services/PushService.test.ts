import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { http, HttpResponse } from 'msw';
import { importJWK, jwtVerify } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anyOf } from '../../platform/lib/test-matchers.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { interceptHttp } from '../../platform/testing/http.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { pushPayload, TEST_PUSH, vapidKeysFrom } from '../lib/web-push.js';
import { PushError, PushService, webPushSend, type PushSend } from './PushService.js';

const ece = createRequire(import.meta.url)('http_ece') as {
  decrypt(buffer: Buffer, params: { version: string; privateKey: crypto.ECDH; authSecret: Buffer }): Buffer;
};

const browser = (n: number) => ({ endpoint: `https://push.example/send/${n}`, keys: { p256dh: `key${n}`, auth: `auth${n}` } });
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36';
const vapid = vapidKeysFrom('k'.repeat(64));

let db: Database;
let send: ReturnType<typeof vi.fn<PushSend>>;
let failing: Map<string, number>;
let logged: string[];
let service: PushService;

beforeEach(() => {
  db = memoryDatabase();
  failing = new Map();
  logged = [];
  send = vi.fn<PushSend>(async (subscription) => {
    const status = failing.get(subscription.endpoint);
    if (status) throw Object.assign(new Error(`push service answered ${status}`), { statusCode: status });
  });
  service = new PushService({ store: db.monitoring, vapid, send, now: () => '2026-10-29T10:00:00.000Z', log: (message) => { logged.push(message); } });
});

describe('a person\'s devices', () => {
  it('are added once per browser, listed with the instance\'s public key, and removed only by their owner', async () => {
    const view = await service.subscribe('alice', browser(1), CHROME);
    expect(view.publicKey).toBe(vapid.publicKey);
    expect(view.devices).toEqual([{ id: anyOf(String), label: 'Chrome on Linux', endpoint: browser(1).endpoint, createdAt: '2026-10-29T10:00:00.000Z' }]);
    expect((await service.subscribe('alice', browser(1), CHROME)).devices).toHaveLength(1);
    expect((await service.subscribe('alice', browser(2), undefined)).devices).toHaveLength(2);
    expect((await service.view('bob')).devices).toEqual([]);
    const id = view.devices[0]!.id;
    await expect(service.remove('bob', id)).rejects.toMatchObject({ status: 404 });
    expect((await service.remove('alice', id)).devices.map((device) => device.label)).toEqual(['A browser on a device']);
  });

  it('refuses a subscription that is not an https address with keys', async () => {
    const refusal = await service.subscribe('alice', { endpoint: 'http://push.example/x' }, CHROME).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(PushError);
    expect(refusal).toMatchObject({ status: 400, message: 'a push service is reached over https' });
    expect((await service.view('alice')).devices).toEqual([]);
  });

  it('each get a push, a gone one is forgotten, and one that failed otherwise is kept', async () => {
    await service.subscribe('alice', browser(1), CHROME);
    await service.subscribe('alice', browser(2), CHROME);
    await service.subscribe('alice', browser(3), CHROME);
    failing.set(browser(2).endpoint, 410);
    failing.set(browser(3).endpoint, 503);
    expect(await service.toPerson('alice', { title: 'Alert: shop is down', body: 'no answer' })).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]?.[0]).toEqual({ endpoint: browser(1).endpoint, keys: browser(1).keys });
    expect(JSON.parse(String(send.mock.calls[0]?.[1]))).toEqual({ title: 'Alert: shop is down', body: 'no answer', path: '/' });
    expect((await service.view('alice')).devices.map((device) => device.endpoint)).toEqual([browser(1).endpoint, browser(3).endpoint]);
    expect(logged).toEqual(['[push] Chrome on Linux of alice unsubscribed; it is forgotten', '[push] could not reach Chrome on Linux of alice: push service answered 503']);
  });

  it('take a test push, and say so when none is set up', async () => {
    await expect(service.test('alice')).rejects.toMatchObject({ status: 409 });
    await service.subscribe('alice', browser(1), CHROME);
    expect(await service.test('alice')).toEqual({ sent: 1 });
    expect((JSON.parse(String(send.mock.calls[0]?.[1])) as { title: string }).title).toBe('Koala can reach this device');
  });
});

describe('sending through a push service', () => {
  const received: Array<{ headers: Headers; body: Buffer }> = [];
  const server = interceptHttp(http.post('https://push.example/send/:id', async ({ request }) => {
    received.push({ headers: request.headers, body: Buffer.from(await request.arrayBuffer()) });
    return new HttpResponse(null, { status: 201 });
  }));

  beforeEach(() => {
    received.length = 0;
    server.resetHandlers();
  });

  it('encrypts for the device, signs as the instance and asks the push service to keep it a day', async () => {
    const device = crypto.createECDH('prime256v1');
    device.generateKeys();
    const authSecret = crypto.randomBytes(16);
    const subscription = { endpoint: 'https://push.example/send/this-device', keys: { p256dh: device.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } };

    await webPushSend(vapid, 'mailto:koala@example.test')(subscription, pushPayload(TEST_PUSH));

    expect(received).toHaveLength(1);
    const [push] = received;
    expect(push!.headers.get('content-encoding')).toBe('aes128gcm');
    expect(push!.headers.get('ttl')).toBe(String(24 * 60 * 60));
    const vapidHeader = /^vapid t=([^,]+),\s*k=(\S+)$/.exec(push!.headers.get('authorization') ?? '');
    expect(vapidHeader).not.toBeNull();
    const [, jwt, key] = vapidHeader!;
    expect(key).toBe(vapid.publicKey);
    const point = Buffer.from(key!, 'base64url');
    const publicKey = await importJWK({ kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') }, 'ES256');
    const { payload } = await jwtVerify(jwt!, publicKey, { audience: 'https://push.example', subject: 'mailto:koala@example.test' });
    expect(payload.exp! * 1000).toBeGreaterThan(Date.now());
    const opened = ece.decrypt(push!.body, { version: 'aes128gcm', privateKey: device, authSecret });
    expect(JSON.parse(opened.toString('utf8'))).toEqual(JSON.parse(pushPayload(TEST_PUSH)));
  });

  it('fails with the push service\'s status when it refuses', async () => {
    server.use(http.post('https://push.example/send/:id', () => new HttpResponse('gone', { status: 410 })));
    const device = crypto.createECDH('prime256v1');
    device.generateKeys();
    const subscription = { endpoint: 'https://push.example/send/gone', keys: { p256dh: device.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
    await expect(webPushSend(vapid, 'mailto:koala@example.test')(subscription, 'x')).rejects.toMatchObject({ statusCode: 410 });
  });
});
