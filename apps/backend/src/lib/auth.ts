import crypto from 'crypto';

/**
 * Hash a password using Node's native crypto.scrypt
 */
export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

/**
 * Verify a password against a hash using Node's native crypto.scrypt
 */
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

/**
 * Simple Helper to convert Object to base64url string
 */
function base64urlEncode(obj: any): string {
  const json = JSON.stringify(obj);
  return Buffer.from(json).toString('base64url');
}

/**
 * Simple Helper to convert base64url string to Object
 */
function base64urlDecode(str: string): any {
  const json = Buffer.from(str, 'base64url').toString('utf8');
  return JSON.parse(json);
}

/**
 * Sign a JSON Web Token using HMAC-SHA256
 */
export function signJWT(payload: Record<string, any>, secret: string, expiresInSeconds: number): string {
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

/**
 * Verify a JSON Web Token signed with HMAC-SHA256
 */
export function verifyJWT(token: string, secret: string): Record<string, any> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;
    if (!encodedHeader || !encodedPayload || !signature) return null;

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(`${encodedHeader}.${encodedPayload}`);
    const expectedSignature = hmac.digest('base64url');

    if (signature !== expectedSignature) return null;

    const payload = base64urlDecode(encodedPayload);
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null; // Expired
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate a cryptographically secure 6-digit numeric OTP code
 */
export function generateOTP(): string {
  const val = crypto.randomInt(100000, 1000000);
  return val.toString();
}
