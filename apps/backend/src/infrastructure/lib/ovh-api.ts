import { createHash } from 'node:crypto';
import type { ResolvedCredentials } from './credential-resolver.js';

export interface OvhKeys {
  applicationKey: string;
  applicationSecret: string;
  consumerKey: string;
}

export interface OvhAccount extends OvhKeys {
  subsidiary: string;
}

export function ovhAccountOf(resolved: ResolvedCredentials): OvhAccount | undefined {
  if (resolved.mode === 'none') return undefined;
  const { OVH_APPLICATION_KEY: applicationKey, OVH_APPLICATION_SECRET: applicationSecret, OVH_CONSUMER_KEY: consumerKey, OVH_SUBSIDIARY: subsidiary } = resolved.env;
  return applicationKey && applicationSecret && consumerKey && subsidiary ? { applicationKey, applicationSecret, consumerKey, subsidiary } : undefined;
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

export function ovhErrorMessage(status: number, body: unknown): string {
  const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
    ? (body as { message: string }).message
    : undefined;
  return message ? `OVHcloud answered ${status}: ${message}` : `OVHcloud answered ${status}`;
}
