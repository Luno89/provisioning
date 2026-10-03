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
      resolve(derivedKey.toString('hex') === key);
    });
  });
}

function base64urlEncode(obj: any): string {
  const json = JSON.stringify(obj);
  return Buffer.from(json).toString('base64url');
}

function base64urlDecode(str: string): any {
  const json = Buffer.from(str, 'base64url').toString('utf8');
  return JSON.parse(json);
}

export function signJWT(payload: Record<string, any>, key: SecretKey, expiresInSeconds: number): string {
  const secret = ringOf(key).current;
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const fullPayload = { ...payload, exp };

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

export function verifyJWT(token: string, key: SecretKey): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;
    if (!encodedHeader || !encodedPayload || !signature) return null;

    const ring = ringOf(key);
    const signed = `${encodedHeader}.${encodedPayload}`;
    if (![ring.current, ...(ring.previous ?? [])].some((secret) => signatureMatches(secret, signed, signature))) return null;

    const payload = base64urlDecode(encodedPayload);
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function generateOTP(): string {
  const val = crypto.randomInt(100000, 1000000);
  return val.toString();
}
