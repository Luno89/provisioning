import crypto from 'crypto';
import { ringOf, type SecretKey } from './crypto.js';

export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [salt, key] = hash.split(':');
    if (!salt || !key) return resolve(false);

    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      const expected = Buffer.from(key, 'hex');
      resolve(expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey));
    });
  });
}

let dummyHash: Promise<string> | undefined;

export async function passwordMatches(password: string, hash: string | undefined): Promise<boolean> {
  if (hash) return verifyPassword(password, hash);
  dummyHash ??= hashPassword(crypto.randomBytes(18).toString('base64url'));
  await verifyPassword(password, await dummyHash);
  return false;
}

function base64urlEncode(obj: unknown): string {
  const json = JSON.stringify(obj);
  return Buffer.from(json).toString('base64url');
}

function base64urlDecode(str: string): Record<string, unknown> | null {
  const json = Buffer.from(str, 'base64url').toString('utf8');
  const parsed: unknown = JSON.parse(json);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

export type TokenPurpose = 'session' | 'client-session' | 'two-factor' | 'device' | 'oauth-state' | 'root-sign-in';

export function signJWT(purpose: TokenPurpose, payload: Record<string, unknown>, key: SecretKey, expiresInSeconds: number): string {
  const secret = ringOf(key).current;
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const fullPayload = { ...payload, purpose, exp };

  const encodedHeader = base64urlEncode(header);
  const encodedPayload = base64urlEncode(fullPayload);

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${encodedHeader}.${encodedPayload}`);
  const signature = hmac.digest('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

const signatureMatches = (secret: string, signed: string, signature: string): boolean => {
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(signed).digest('base64url'));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};

export function verifyJWT(token: string, purpose: TokenPurpose, key: SecretKey): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;
    if (!encodedHeader || !encodedPayload || !signature) return null;

    const ring = ringOf(key);
    const signed = `${encodedHeader}.${encodedPayload}`;
    if (![ring.current, ...(ring.previous ?? [])].some((secret) => signatureMatches(secret, signed, signature))) return null;

    const payload = base64urlDecode(encodedPayload);
    if (!payload) return null;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    if (payload.purpose !== purpose) return null;

    return payload;
  } catch {
    return null;
  }
}

export function generateOTP(): string {
  const val = crypto.randomInt(100000, 1000000);
  return val.toString();
}

export const signsEveryoneIn = (env: Record<string, string | undefined>): boolean =>
  env.IS_E2E === 'true' && env.NODE_ENV !== 'production';

export function e2eProblem(env: Record<string, string | undefined>): string | undefined {
  return env.IS_E2E === 'true' && env.NODE_ENV === 'production'
    ? 'IS_E2E signs every request in as the first account, so a production server refuses to start with it set'
    : undefined;
}

export const SESSION_SECONDS = 24 * 60 * 60;

export const SESSION_COOKIE = 'session';

export const cookieNamed = (name: string, secure: boolean): string => (secure ? `__Host-${name}` : name);

export const DEVICE_COOKIE = 'device';

export const DEVICE_SECONDS = 365 * 24 * 60 * 60;

export interface SignedInDevice {
  account: string;
  id: string;
}

export const deviceToken = (account: string, key: SecretKey, id: string = crypto.randomUUID()): string =>
  signJWT('device', { deviceFor: account.trim().toLowerCase(), device: id }, key, DEVICE_SECONDS);

export function deviceOf(token: string | undefined, key: SecretKey): SignedInDevice | undefined {
  if (!token) return undefined;
  const decoded = verifyJWT(token, 'device', key);
  return decoded && typeof decoded.deviceFor === 'string' && typeof decoded.device === 'string' && decoded.device
    ? { account: decoded.deviceFor, id: decoded.device }
    : undefined;
}

export const arrivedOverHttps = (forwardedProto: string | string[] | undefined, encrypted: boolean): boolean =>
  encrypted || String(forwardedProto ?? '').split(',')[0]?.trim() === 'https';

export const sessionToken = (user: { id: string; email: string }, key: SecretKey, options: { now?: number; seconds?: number } = {}): string =>
  signJWT('session', { userId: user.id, email: user.email, sessionAt: options.now ?? Date.now(), jti: crypto.randomUUID() }, key, options.seconds ?? SESSION_SECONDS);

export interface SignedSession {
  userId: string;
  jti: string;
  sessionAt: number;
  until: number;
}

export function signedSession(decoded: Record<string, unknown> | null | undefined): SignedSession | undefined {
  if (!decoded) return undefined;
  const { userId, jti, sessionAt, exp } = decoded;
  if (typeof userId !== 'string' || !userId || typeof jti !== 'string' || !jti) return undefined;
  if (typeof sessionAt !== 'number' || !Number.isFinite(sessionAt) || typeof exp !== 'number') return undefined;
  return { userId, jti, sessionAt, until: exp * 1000 };
}

export const sessionEnded = (session: Pick<SignedSession, 'sessionAt'>, user: { sessionsEndedAt?: string | undefined }): boolean =>
  user.sessionsEndedAt !== undefined && session.sessionAt < Date.parse(user.sessionsEndedAt);
