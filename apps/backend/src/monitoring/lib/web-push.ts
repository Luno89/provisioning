import crypto from 'crypto';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionRecord {
  id: string;
  ownerId: string;
  endpoint: string;
  keys: PushKeys;
  label: string;
  createdAt: string;
}

export interface PushMessage {
  title: string;
  body: string;
  path?: string | undefined;
  tag?: string | undefined;
}

export interface PushDevice {
  id: string;
  label: string;
  endpoint: string;
  createdAt: string;
}

const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

const derived = new Map<string, VapidKeys>();

export function vapidKeysFrom(secret: string): VapidKeys {
  const known = derived.get(secret);
  if (known) return known;
  for (let round = 0; ; round += 1) {
    const scalar = Buffer.from(crypto.hkdfSync('sha256', secret, 'nowrinkles-web-push', `vapid-${round}`, 32));
    const value = BigInt(`0x${scalar.toString('hex')}`);
    if (value === 0n || value >= P256_ORDER) continue;
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(scalar);
    const keys = { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: scalar.toString('base64url') };
    derived.set(secret, keys);
    return keys;
  }
}

export function vapidSubject(mailFrom: string | undefined, publicUrl: string): string {
  const address = mailFrom ? /<([^>]+)>/.exec(mailFrom)?.[1] ?? mailFrom.trim() : undefined;
  if (address && /^[^\s@]+@[^\s@]+$/.test(address)) return `mailto:${address}`;
  if (publicUrl.startsWith('https://')) return new URL(publicUrl).origin;
  return `mailto:koala@${new URL(publicUrl).hostname || 'localhost'}`;
}

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export function subscriptionProblem(raw: unknown): string | undefined {
  const subscription = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
  if (!subscription || typeof subscription.endpoint !== 'string') return 'send the browser\'s push subscription';
  let endpoint: URL;
  try {
    endpoint = new URL(subscription.endpoint);
  } catch {
    return 'the subscription\'s endpoint is not an address';
  }
  if (endpoint.protocol !== 'https:') return 'a push service is reached over https';
  const { p256dh, auth } = subscription.keys ?? {};
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !BASE64URL.test(p256dh) || !BASE64URL.test(auth)) return 'the subscription carries no keys';
  return undefined;
}

export function deviceLabel(userAgent: string | undefined): string {
  const agent = userAgent ?? '';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'A browser';
  const system = /iPhone|iPad/.test(agent) ? 'iPhone or iPad' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : 'a device';
  return `${browser} on ${system}`;
}

const MAX_TEXT = 300;

const clipped = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

export const pushPayload = (message: PushMessage): string =>
  JSON.stringify({ title: clipped(message.title), body: clipped(message.body), path: message.path ?? '/', ...(message.tag ? { tag: message.tag } : {}) });

export const gone = (statusCode: unknown): boolean => statusCode === 404 || statusCode === 410;

export const TEST_PUSH: PushMessage = { title: 'Koala can reach this device', body: 'This is the test you asked for. Alerts and things waiting on you will arrive like this.', path: '/#/settings', tag: 'koala-test' };

export const alertPush = (episode: { name: string; summary: string }, change: 'fired' | 'resolved'): PushMessage => ({
  title: change === 'fired' ? `Alert: ${episode.name}` : `Resolved: ${episode.name}`,
  body: episode.summary || (change === 'fired' ? 'An alert you set is firing.' : 'An alert you set has resolved.'),
  path: '/#/infrastructure',
  tag: `alert-${episode.name}`,
});

export const askingPush = (tool: string): PushMessage => ({
  title: 'A run is waiting for you',
  body: `It asks to use ${tool}. Open Koala to allow it or not.`,
  path: '/#/infrastructure',
  tag: 'koala-asking',
});

export const previewPush = (text: string): PushMessage => ({
  title: 'A release is waiting for you',
  body: text,
  path: '/#/projects',
  tag: 'koala-preview',
});
