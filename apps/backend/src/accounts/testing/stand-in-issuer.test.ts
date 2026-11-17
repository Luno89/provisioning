import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { duplexPair } from 'node:stream';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { interceptHttp } from '../../platform/testing/http.js';
import { startStandInIssuer, type StandInIssuer } from './stand-in-issuer.js';

const served = vi.hoisted(() => ({ server: undefined as Server | undefined, port: 40123 }));

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    default: {
      ...actual,
      createServer: (...args: Parameters<typeof actual.createServer>) => {
        const server = actual.createServer(...args);
        served.server = server;
        Object.assign(server, {
          listen: (_port: number, _host: string, ready: () => void) => { ready(); return server; },
          address: () => ({ port: served.port }),
        });
        return server;
      },
    },
  };
});

const ORIGIN = `http://127.0.0.1:${served.port}`;
const REDIRECT = 'https://app.example.test/api/auth/provider/oidc/callback';
const person = { sub: 'sub-1', email: 'ann@example.com', email_verified: true };

async function bridge(request: Request): Promise<Response> {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  const [clientSide, serverSide] = duplexPair();
  served.server!.emit('connection', serverSide);
  const url = new URL(request.url);
  const body = Buffer.from(await request.arrayBuffer());
  const agent = new actual.Agent();
  agent.createConnection = () => clientSide as never;
  return new Promise<Response>((done, failed) => {
    const sent = actual.request({
      host: url.hostname, port: url.port, path: url.pathname + url.search, method: request.method, agent,
      headers: { ...Object.fromEntries(request.headers), connection: 'close', ...(body.length ? { 'content-length': String(body.length) } : {}) },
    }, (answer) => {
      const chunks: Buffer[] = [];
      answer.on('data', (chunk: Buffer) => chunks.push(chunk));
      answer.on('end', () => {
        const headers = new Headers();
        for (let at = 0; at < answer.rawHeaders.length; at += 2) headers.append(answer.rawHeaders[at]!, answer.rawHeaders[at + 1]!);
        done(new Response([204, 304].includes(answer.statusCode ?? 0) ? null : Buffer.concat(chunks), { status: answer.statusCode ?? 500, headers }));
      });
    });
    sent.on('error', failed);
    sent.end(body);
  });
}

interceptHttp(http.all(`${ORIGIN}/*`, ({ request }) => bridge(request)));

let issuer: StandInIssuer | undefined;
afterEach(async () => { await issuer?.close(); issuer = undefined; });

const VERIFIER = 'a-verifier-of-sufficient-length-for-pkce-123456';

function authorizationUrl(of: StandInIssuer, extra: Record<string, string> = {}): string {
  const url = new URL(`${of.issuer}/auth`);
  for (const [key, value] of Object.entries({
    client_id: of.clientId, response_type: 'code', redirect_uri: REDIRECT, scope: 'openid email profile', state: 'state-1', nonce: 'nonce-1',
    code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'), code_challenge_method: 'S256', ...extra,
  })) url.searchParams.set(key, value);
  return url.href;
}

async function signedIn(of: StandInIssuer): Promise<string> {
  const back = await of.authorize(authorizationUrl(of));
  const code = back.searchParams.get('code');
  if (!code) throw new Error(`no code came back: ${back.href}`);
  const answer = await fetch(`${of.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: of.clientId, client_secret: of.clientSecret, code_verifier: VERIFIER }),
  });
  const tokens = await answer.json() as { id_token?: string; error?: string };
  if (!tokens.id_token) throw new Error(`no ID token: ${JSON.stringify(tokens)}`);
  return tokens.id_token;
}

const keysOf = async (of: StandInIssuer) => createLocalJWKSet(await (await fetch(`${of.issuer}/jwks`)).json() as Parameters<typeof createLocalJWKSet>[0]);

describe('the stand-in OpenID provider', () => {
  it('serves its own discovery document at the address it listens on, and keeps the client credentials it was given', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT], clientId: 'koala-test', clientSecret: 'the-secret' });
    expect(issuer.issuer).toBe(ORIGIN);
    expect([issuer.clientId, issuer.clientSecret]).toEqual(['koala-test', 'the-secret']);
    const found = await (await fetch(`${issuer.issuer}/.well-known/openid-configuration`)).json() as { issuer: string; authorization_endpoint: string };
    expect(found.issuer).toBe(ORIGIN);
    expect(found.authorization_endpoint).toBe(`${ORIGIN}/auth`);
  });

  it('makes up a client id and secret of its own when none are given', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT] });
    expect(issuer.clientId).toBe('koala-sign-in');
    expect(issuer.clientSecret).toMatch(/^secret-/);
  });

  it('signs the person it was told to sign in, sending the browser back to the app with a code and the state, and remembers what it was asked', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT] });
    issuer.signInAs(person);
    const back = await issuer.authorize(authorizationUrl(issuer));
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('state-1');
    expect(back.searchParams.get('code')).toEqual(expect.any(String));
    const [asked] = issuer.asked();
    expect(asked?.get('nonce')).toBe('nonce-1');
    expect(asked?.get('code_challenge_method')).toBe('S256');
  });

  it('gives an ID token that names the person, their address and whether it was verified, signed with its published key', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT] });
    issuer.signInAs(person);
    const token = await signedIn(issuer);
    const { payload } = await jwtVerify(token, await keysOf(issuer), { issuer: issuer.issuer, audience: issuer.clientId });
    expect(payload).toMatchObject({ sub: 'sub-1', email: 'ann@example.com', email_verified: true, nonce: 'nonce-1' });
  });

  it('refuses the sign-in when nobody was told to sign in, sending the browser back with the refusal', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT] });
    const back = await issuer.authorize(authorizationUrl(issuer));
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('forges what it was told to, and only that', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT] });
    issuer.signInAs(person);
    const keys = await keysOf(issuer);

    issuer.mischief('signature');
    await expect(jwtVerify(await signedIn(issuer), keys)).rejects.toThrow();

    issuer.mischief('audience');
    expect(decodeJwt(await signedIn(issuer)).aud).toBe('someone-else');

    issuer.mischief('nonce');
    expect(decodeJwt(await signedIn(issuer)).nonce).toBe('a-nonce-nobody-sent');

    issuer.mischief('issuer');
    expect(decodeJwt(await signedIn(issuer)).iss).toBe('https://pretender.example.com');

    issuer.mischief('none');
    await expect(jwtVerify(await signedIn(issuer), keys, { issuer: issuer.issuer, audience: issuer.clientId })).resolves.toBeDefined();
  });

  it('will not send a browser that was not sent to it, and says where it got stuck when it cannot go on', async () => {
    issuer = await startStandInIssuer({ redirectUris: [REDIRECT] });
    await expect(issuer.authorize('https://elsewhere.example.test/auth')).rejects.toThrow(`the sign-in was sent to https://elsewhere.example.test, not the stand-in ${ORIGIN}`);
    await expect(issuer.authorize(`${ORIGIN}/nowhere`)).rejects.toThrow(/the stand-in issuer stopped at \/nowhere: 404/);
  });

  it('stops listening when closed', async () => {
    const closing = await startStandInIssuer({ redirectUris: [REDIRECT] });
    await expect(closing.close()).resolves.toBeUndefined();
  });
});
