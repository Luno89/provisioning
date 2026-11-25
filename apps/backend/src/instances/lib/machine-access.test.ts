import { describe, expect, it } from 'vitest';
import { errors, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { failureOf } from '@koala/engine-core/failures';
import { checkMachineAccess } from './machine-access.js';
import { ACCESS_JWT_TYP, SIGNING_ALG } from './oidc.js';

const EXPECTED = { issuer: 'https://root.example/oidc', audience: 'https://koala.example/run', now: Date.now() };
const { privateKey } = await generateKeyPair(SIGNING_ALG);
const TOKEN = await new SignJWT({ sub: 'desk' }).setProtectedHeader({ alg: SIGNING_ALG, typ: ACCESS_JWT_TYP }).sign(privateKey);

const rootUnreachable: JWTVerifyGetKey = async () => {
  throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }) });
};

const noKeyOfRoot: JWTVerifyGetKey = async () => {
  throw new errors.JWKSNoMatchingKey();
};

describe('checking a machine\'s token against root\'s keys', () => {
  it('fails as temporary when root\'s keys could not be fetched, so the token is never called wrong while root is away', async () => {
    const checked = checkMachineAccess(TOKEN, rootUnreachable, EXPECTED);
    await expect(checked).rejects.toThrow(/^the machine's token could not be checked just now: /);
    const thrown = await checked.catch((err: unknown) => err);
    expect(failureOf(thrown).kind).toBe('temporary');
    expect((thrown as { status?: number }).status, 'a route that meets it answers 503, which a machine\'s Prometheus and git retry').toBe(503);
  });

  it('refuses a token root\'s keys were read for and do not sign', async () => {
    expect(await checkMachineAccess(TOKEN, noKeyOfRoot, EXPECTED)).toMatch(/^the machine's token could not be checked: /);
  });
});
