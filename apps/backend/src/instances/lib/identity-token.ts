import crypto from 'crypto';

export interface IdentityKeyPair {
  kid: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
}

export const publicKeyPem = (key: crypto.KeyObject): string => key.export({ type: 'spki', format: 'pem' }).toString();

export const kidOf = (publicKey: crypto.KeyObject): string =>
  crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

export function identityKeysFrom(privateKeyPem: string): IdentityKeyPair {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the identity key has to be an Ed25519 private key');
  const publicKey = crypto.createPublicKey(privateKey);
  return { kid: kidOf(publicKey), privateKey, publicKey };
}

export function identityKeysFromSeed(seed: Buffer): IdentityKeyPair {
  if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = crypto.createPublicKey(privateKey);
  return { kid: kidOf(publicKey), privateKey, publicKey };
}

export const generateIdentityKey = (): string =>
  crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

export function trustedKeys(publicKeyPems: readonly string[]): Map<string, crypto.KeyObject> {
  return new Map(publicKeyPems.map((pem) => {
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('a trusted identity key has to be an Ed25519 public key');
    return [kidOf(key), key] as const;
  }));
}
