import { createHash } from 'node:crypto';

export interface OvhKeys {
  applicationKey: string;
  applicationSecret: string;
  consumerKey: string;
}

export interface OvhSigned {
  'X-Ovh-Application': string;
  'X-Ovh-Consumer': string;
  'X-Ovh-Timestamp': string;
  'X-Ovh-Signature': string;
}

export function ovhSignature(keys: Pick<OvhKeys, 'applicationSecret' | 'consumerKey'>, method: string, url: string, body: string, timestamp: number): string {
  const signed = [keys.applicationSecret, keys.consumerKey, method.toUpperCase(), url, body, String(timestamp)].join('+');
  return `$1$${createHash('sha1').update(signed).digest('hex')}`;
}

export function ovhHeaders(keys: OvhKeys, method: string, url: string, body: string, timestamp: number): OvhSigned {
  return {
    'X-Ovh-Application': keys.applicationKey,
    'X-Ovh-Consumer': keys.consumerKey,
    'X-Ovh-Timestamp': String(timestamp),
    'X-Ovh-Signature': ovhSignature(keys, method, url, body, timestamp),
  };
}

export const OVH_ACCESS_RULES: readonly string[] = ['GET /*', 'POST /order/*', 'DELETE /order/*', 'POST /vps/*', 'POST /me/order/*', 'POST /ip/*'];

export const ovhCreateTokenUrl = (apiHost: string): string => `${apiHost.replace(/\/1\.0$/, '')}/createToken/`;

export function ovhErrorMessage(status: number, body: unknown): string {
  const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
    ? (body as { message: string }).message
    : undefined;
  return message ? `OVHcloud answered ${status}: ${message}` : `OVHcloud answered ${status}`;
}
