import { describe, expect, it } from 'vitest';
import { errors, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { failureOf } from '@koala/engine-core/failures';
import { checkMachineAccess, rootKeySet } from './machine-access.js';
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

  it('fails as temporary when root\'s key set answers 502, 503 or 429, as root restarting behind its Caddy does, and keeps the answer\'s status', async () => {
    for (const status of [502, 503, 429]) {
      const answered = rootKeySet(new URL('https://root.example/oidc/jwks'), async () => new Response('restarting', { status }));
      const thrown = await checkMachineAccess(TOKEN, answered, EXPECTED).catch((err: unknown) => err);
      expect(failureOf(thrown), `an answer of ${status}`).toMatchObject({ kind: 'temporary' });
      expect(String((thrown as Error).message)).toMatch(/^the machine's token could not be checked just now: /);
    }
  });

  it('refuses a token when root\'s key set answers 404, which root restarting never does', async () => {
    const answered = rootKeySet(new URL('https://root.example/oidc/jwks'), async () => new Response('no such page', { status: 404 }));
    expect(await checkMachineAccess(TOKEN, answered, EXPECTED)).toMatch(/^the machine's token could not be checked: /);
  });

  it('refuses a token root\'s keys were read for and do not sign', async () => {
    expect(await checkMachineAccess(TOKEN, noKeyOfRoot, EXPECTED)).toMatch(/^the machine's token could not be checked: /);
  });
});
