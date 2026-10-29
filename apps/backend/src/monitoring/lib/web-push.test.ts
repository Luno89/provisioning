import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { alertPush, askingPush, deviceLabel, gone, pushPayload, subscriptionProblem, vapidKeysFrom, vapidSubject } from './web-push.js';

const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BOr-key_1', auth: 'auth-2' } };

describe('the instance\'s push keys', () => {
  it('are one P-256 pair derived from the data key, the same every start and different per instance', () => {
    const keys = vapidKeysFrom('a'.repeat(64));
    expect(vapidKeysFrom('a'.repeat(64))).toBe(keys);
    expect(vapidKeysFrom('b'.repeat(64)).publicKey).not.toBe(keys.publicKey);
    const point = Buffer.from(keys.publicKey, 'base64url');
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(4);
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(keys.privateKey, 'base64url'));
    expect(ecdh.getPublicKey().toString('base64url')).toBe(keys.publicKey);
  });

  it('name who sends them: the mail sender, else the https address, else a mailto on the host', () => {
    expect(vapidSubject('Koala <alerts@nowrinkles.app>', 'http://localhost:3001')).toBe('mailto:alerts@nowrinkles.app');
    expect(vapidSubject(undefined, 'https://luno.nowrinkles.app/')).toBe('https://luno.nowrinkles.app');
    expect(vapidSubject(undefined, 'http://dev.localhost:5173')).toBe('mailto:koala@dev.localhost');
  });
});

describe('a browser\'s subscription', () => {
  it('is taken only with an https push service and its keys', () => {
    expect(subscriptionProblem(subscription)).toBeUndefined();
    expect(subscriptionProblem(undefined)).toMatch(/send the browser/);
    expect(subscriptionProblem({ ...subscription, endpoint: 'http://push.example/x' })).toMatch(/https/);
    expect(subscriptionProblem({ ...subscription, endpoint: 'not a url' })).toMatch(/not an address/);
    expect(subscriptionProblem({ endpoint: subscription.endpoint, keys: { p256dh: 'has space', auth: 'a' } })).toMatch(/no keys/);
  });

  it('is named by its browser and system, never by anything else it sends', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone or iPad');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36')).toBe('Chrome on Linux');
    expect(deviceLabel(undefined)).toBe('A browser on a device');
  });

  it('is forgotten when the push service says it is gone', () => {
    expect(gone(404)).toBe(true);
    expect(gone(410)).toBe(true);
    expect(gone(500)).toBe(false);
  });
});

describe('what a push carries', () => {
  it('is the platform\'s own words, clipped, with where to open', () => {
    const payload = JSON.parse(pushPayload({ title: 't', body: 'x'.repeat(400), path: '/#/x', tag: 'k' })) as { body: string; path: string; tag: string };
    expect(payload.body).toHaveLength(300);
    expect(payload.path).toBe('/#/x');
    expect(JSON.parse(pushPayload({ title: 't', body: 'b' })).path).toBe('/');
    expect(alertPush({ name: 'shop is down', summary: 'shop has not answered its probe for 2 minutes' }, 'fired')).toMatchObject({ title: 'Alert: shop is down', body: 'shop has not answered its probe for 2 minutes' });
    expect(alertPush({ name: 'shop is down', summary: '' }, 'resolved').title).toBe('Resolved: shop is down');
    expect(askingPush('delete_file').body).toBe('It asks to use delete_file. Open Koala to allow it or not.');
  });
});
