import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import axios from 'axios';
import { importJWK, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import { pushPayload, TEST_PUSH, vapidKeysFrom } from '../lib/web-push.js';
import { PushService, webPushSend } from '../services/PushService.js';
import { notificationsRouter } from './notifications.js';

const ece = createRequire(import.meta.url)('http_ece') as {
  decrypt(buffer: Buffer, params: { version: string; privateKey: crypto.ECDH; authSecret: Buffer }): Buffer;
};

const SUBJECT = 'mailto:koala@example.test';
const vapid = vapidKeysFrom('push-delivery-test-secret');

interface Received { headers: Record<string, string | string[] | undefined>; body: Buffer; path: string }

let folder = '';
let stub: https.Server;
let stubOrigin = '';
let harness: Harness;
const received: Received[] = [];
const previousCa = https.globalAgent.options.ca;

beforeAll(async () => {
  folder = mkdtempSync(path.join(tmpdir(), 'push-stub-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(folder, 'key.pem'), '-out', path.join(folder, 'cert.pem')], { stdio: 'ignore' });
  const cert = readFileSync(path.join(folder, 'cert.pem'));
  stub = https.createServer({ key: readFileSync(path.join(folder, 'key.pem')), cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks), path: req.url ?? '' });
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((done) => stub.listen(0, '127.0.0.1', done));
  stubOrigin = `https://localhost:${(stub.address() as AddressInfo).port}`;
  https.globalAgent.options.ca = cert;
  harness = await mountRouter({
    prefix: '/api/notifications',
    router: (db) => notificationsRouter({
      notifications: { view: async () => ({}) as never, set: async () => ({}) as never },
      mail: { toOwner: async () => undefined } as never,
      push: new PushService({ store: db.monitoring, vapid, send: webPushSend(vapid, SUBJECT), log: () => undefined }),
    }),
  });
});

afterAll(async () => {
  https.globalAgent.options.ca = previousCa;
  await harness.close();
  await new Promise<void>((done) => stub.close(() => done()));
  rmSync(folder, { recursive: true, force: true });
});

describe('a push to a person\'s device', () => {
  it('goes to their push service encrypted for that device and signed by the instance, and says what the notice says', async () => {
    const device = crypto.createECDH('prime256v1');
    device.generateKeys();
    const authSecret = crypto.randomBytes(16);
    const subscription = { endpoint: `${stubOrigin}/push/this-device`, keys: { p256dh: device.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } };

    const subscribed = await axios.post(harness.url('/api/notifications/push'), { subscription }, { validateStatus: () => true });
    expect(subscribed.status, JSON.stringify(subscribed.data)).toBe(200);
    expect((subscribed.data as { publicKey: string }).publicKey).toBe(vapid.publicKey);

    const tested = await axios.post(harness.url('/api/notifications/push/test'), {}, { validateStatus: () => true });
    expect(tested.status, JSON.stringify(tested.data)).toBe(200);
    expect(tested.data).toEqual({ sent: 1 });

    expect(received).toHaveLength(1);
    const [push] = received;
    expect(push!.path).toBe('/push/this-device');
    expect(push!.headers['content-encoding']).toBe('aes128gcm');

    const authorization = String(push!.headers.authorization);
    const vapidHeader = /^vapid t=([^,]+),\s*k=(\S+)$/.exec(authorization);
    expect(vapidHeader, authorization).not.toBeNull();
    const [, jwt, key] = vapidHeader!;
    expect(key).toBe(vapid.publicKey);
    const point = Buffer.from(key!, 'base64url');
    const publicKey = await importJWK({ kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') }, 'ES256');
    const { payload } = await jwtVerify(jwt!, publicKey, { audience: stubOrigin, subject: SUBJECT });
    expect(payload.exp! * 1000).toBeGreaterThan(Date.now());

    const opened = ece.decrypt(push!.body, { version: 'aes128gcm', privateKey: device, authSecret });
    expect(JSON.parse(opened.toString('utf8'))).toEqual(JSON.parse(pushPayload(TEST_PUSH)));
  });
});
