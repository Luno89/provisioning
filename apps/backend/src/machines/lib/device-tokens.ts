import crypto from 'crypto';

export const DEVICE_TOKEN_DAYS = 90;
export const ROTATE_WITHIN_DAYS = 30;
export const TOKEN_EXPIRED_SAID = 'its token expired while it was offline; run the command from My Machines again';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DeviceTokenState {
  tokenHash?: string | undefined;
  issuedAt?: string | undefined;
  expiresAt?: string | undefined;
  nextTokenHash?: string | undefined;
  nextIssuedAt?: string | undefined;
  nextExpiresAt?: string | undefined;
}

export type TokenVia = 'current' | 'next';

export const deviceTokenHash = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

export const newDeviceToken = (): string => crypto.randomBytes(32).toString('base64url');

export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export const tokenLifetime = (now: Date): { issuedAt: string; expiresAt: string } =>
  ({ issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + DEVICE_TOKEN_DAYS * DAY_MS).toISOString() });

const passed = (at: string | undefined, now: Date): boolean => at !== undefined && Date.parse(at) <= now.getTime();

export const tokenExpired = (device: DeviceTokenState, now: Date): boolean => passed(device.expiresAt, now);

export const rotationDue = (device: DeviceTokenState, now: Date): boolean =>
  device.nextTokenHash === undefined
  && (device.expiresAt === undefined || Date.parse(device.expiresAt) - now.getTime() <= ROTATE_WITHIN_DAYS * DAY_MS);

export function viaOf(device: DeviceTokenState, presentedHash: string, now: Date): { via: TokenVia; expired: boolean } | undefined {
  if (device.tokenHash && hashesEqual(device.tokenHash, presentedHash)) return { via: 'current', expired: tokenExpired(device, now) };
  if (device.nextTokenHash && hashesEqual(device.nextTokenHash, presentedHash)) return { via: 'next', expired: passed(device.nextExpiresAt, now) };
  return undefined;
}

export function withNextToken<T extends DeviceTokenState>(device: T, nextHash: string, now: Date): T {
  const life = tokenLifetime(now);
  return { ...device, nextTokenHash: nextHash, nextIssuedAt: life.issuedAt, nextExpiresAt: life.expiresAt };
}

export function promotedNext<T extends DeviceTokenState>(device: T): T {
  if (!device.nextTokenHash) return device;
  const { nextTokenHash, nextIssuedAt, nextExpiresAt, ...rest } = device;
  return { ...rest, tokenHash: nextTokenHash, issuedAt: nextIssuedAt, expiresAt: nextExpiresAt } as T;
}

export function withLifetime<T extends DeviceTokenState>(device: T, now: Date): T {
  if (!device.tokenHash || device.expiresAt !== undefined) return device;
  return { ...device, ...tokenLifetime(now) };
}
