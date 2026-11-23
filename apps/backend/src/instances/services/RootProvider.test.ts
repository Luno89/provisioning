import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { generateIdentityKey, identityKeysFrom } from '../lib/identity-token.js';
import { ROOT_WEB_CLIENT, SIGNING_ALG } from '../lib/oidc.js';
import { injectedFetch } from '../../platform/testing/injected-fetch.js';
import { rootWebFor } from '../testing/root-web.js';
import { InstanceReach } from './InstanceReach.js';
import { RootProvider } from './RootProvider.js';

const nothingHeld = {
  instances: { getInstances: async () => [], oidcFind: async () => undefined, oidcFindBy: async () => undefined },
  machines: { getLocalAgentDevices: async () => [] },
  accounts: { getUserById: async () => undefined },
} as unknown as ConstructorParameters<typeof RootProvider>[1];

const url = 'https://root.example';
const provider = new RootProvider({ issuer: url, signing: identityKeysFrom(generateIdentityKey()), cookieKey: 'a-provider-that-refuses-clients', proxied: false, reach: new InstanceReach({ open: true }), web: rootWebFor(url), dataKey: 'a'.repeat(64) }, nothingHeld);
const answering = provider.provider.callback();
const toRoot = injectedFetch((req, res) => { void answering(req, res); });

afterEach(() => {
  vi.restoreAllMocks();
});

const said = (warn: { mock: { calls: unknown[][] } }): string => warn.mock.calls.map((call) => call.join(' ')).join('\n');

const asToken = (form: Record<string, string>, headers: Record<string, string> = {}) =>
  toRoot(`${url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form) });

describe('a client root refuses at its token endpoint', () => {
  it('is logged with its id and the provider\'s reason, never its assertion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stranger = identityKeysFrom(generateIdentityKey());
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: SIGNING_ALG, kid: stranger.kid }).setIssuer(ROOT_WEB_CLIENT).setSubject(ROOT_WEB_CLIENT)
      .setAudience(`${url}/elsewhere`).setJti('one').setIssuedAt().setExpirationTime('1m').sign(stranger.privateKey);
    const answer = await asToken({ grant_type: 'client_credentials', client_id: ROOT_WEB_CLIENT, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion });
    expect(answer.status).toBe(401);
    expect(said(warn)).toContain(`[sign-in] root refused ${ROOT_WEB_CLIENT} at its token endpoint: invalid_client (client authentication failed): audience (aud) must equal the endpoint url, issuer identifier or token endpoint url`);
    expect(said(warn)).not.toContain(assertion);
    expect(said(warn)).not.toContain(assertion.split('.')[2]);
  });

  it('names a client root does not know by the id it gave, never its secret', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const secret = 'a-secret-root-must-never-print';
    const answer = await asToken({ grant_type: 'client_credentials' }, { authorization: `Basic ${Buffer.from(`nobody-known:${secret}`).toString('base64')}` });
    expect(answer.status).toBe(401);
    expect(said(warn)).toContain('[sign-in] root refused nobody-known at its token endpoint: invalid_client (client authentication failed): client not found');
    expect(said(warn)).not.toContain(secret);
  });
});
