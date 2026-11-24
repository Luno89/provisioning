import { describe, expect, it } from 'vitest';
import express, { Router } from 'express';
import { LOGOUT_SCRIPT, OIDC_PATH } from '../lib/oidc.js';
import { serveInProcess } from '../testing/serve-in-process.js';
import { oidcProviderRouter } from './oidc-provider.js';
import type { RootProvider } from '../services/RootProvider.js';

const provider = {
  provider: { callback: () => (req: { url: string }, res: { statusCode: number; end: (text: string) => void }) => { res.statusCode = 200; res.end(`the provider answered ${req.url}`); } },
  issuer: 'http://root.test/oidc',
  proxied: false,
  continueInteraction: async () => undefined,
} as unknown as Pick<RootProvider, 'provider' | 'continueInteraction' | 'issuer' | 'proxied'>;

describe('root\'s provider routes', () => {
  it('serve the script that submits the logout page, as root\'s own script, so a browser runs it under root\'s policy', async () => {
    const app = express();
    app.use(OIDC_PATH, oidcProviderRouter({ provider, signedIn: async () => undefined, endBrowserSession: async () => undefined, interactions: Router() }));
    const answer = await serveInProcess(app, new Request('http://root.test/oidc/logout.js'));
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toMatch(/^application\/javascript/);
    expect(await answer.text()).toBe(LOGOUT_SCRIPT);
  });
});

describe('confirming a logout at root', () => {
  it('ends root\'s own sign-in in this browser before the provider ends its session, so nothing signs the browser back in', async () => {
    const ended: string[] = [];
    const app = express();
    app.use(OIDC_PATH, oidcProviderRouter({ provider, signedIn: async () => undefined, endBrowserSession: async (req) => { ended.push(req.path); }, interactions: Router() }));
    const answer = await serveInProcess(app, new Request('http://root.test/oidc/session/end/confirm', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'xsrf=x&logout=yes' }));
    expect(ended).toEqual(['/session/end/confirm']);
    expect(await answer.text()).toBe('the provider answered /session/end/confirm');
  });
});
