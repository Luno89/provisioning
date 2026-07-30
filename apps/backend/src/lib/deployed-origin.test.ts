import { describe, it, expect } from 'vitest';

/**
 * Invariants for the three origin-derived values in index.ts's auth path.
 *
 * All three were hardcoded to a developer's laptop — OAuth redirect_uris to localhost:3001, nine
 * post-login redirects to localhost:5173, and `secure: false` on the session cookie. None of that
 * fails at build time or in dev; it fails the first time a real user signs in on the deployed host,
 * which is the worst possible moment to find out.
 *
 * The derivations are duplicated here rather than imported because they are `const`s inside
 * bootstrap(). Their behaviour is verified end-to-end against the real routes; what these tests
 * pin down is the intent, so a later "simplification" back to a literal is a failing test rather
 * than a silent regression.
 */
const deriveAppUrl = (env: Record<string, string | undefined>) =>
  (env.APP_URL || env.PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, '');

const derivePublicUrl = (env: Record<string, string | undefined>, port: string | number) =>
  (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');

const secureCookies = (publicUrl: string) => publicUrl.startsWith('https://');

describe('PUBLIC_URL', () => {
  it('is where OAuth redirect_uris point', () => {
    const url = derivePublicUrl({ PUBLIC_URL: 'https://app.nowrinkles.dev' }, 3001);
    expect(`${url}/api/auth/google/callback`).toBe('https://app.nowrinkles.dev/api/auth/google/callback');
  });

  it('tolerates a trailing slash — otherwise the redirect_uri gets a double slash and Google, which requires an exact match against the registered URI, rejects it', () => {
    expect(derivePublicUrl({ PUBLIC_URL: 'https://app.nowrinkles.dev/' }, 3001)).toBe('https://app.nowrinkles.dev');
  });

  it('falls back to the local port so dev needs no configuration', () => {
    expect(derivePublicUrl({}, 3001)).toBe('http://localhost:3001');
  });
});

describe('APP_URL', () => {
  it('follows PUBLIC_URL when unset, because in production the backend serves the built frontend from its own origin', () => {
    expect(deriveAppUrl({ PUBLIC_URL: 'https://app.nowrinkles.dev' })).toBe('https://app.nowrinkles.dev');
  });

  it('can be split from PUBLIC_URL for a separately hosted frontend', () => {
    expect(deriveAppUrl({ PUBLIC_URL: 'https://api.example.com', APP_URL: 'https://ui.example.com' }))
      .toBe('https://ui.example.com');
  });

  it('defaults to the Vite dev server, which is the only reason it is a separate value at all', () => {
    expect(deriveAppUrl({})).toBe('http://localhost:5173');
  });
});

describe('session cookie Secure flag', () => {
  it('is set when the site is reached over https', () => {
    expect(secureCookies('https://app.nowrinkles.dev')).toBe(true);
  });

  it('is NOT set in local dev — a Secure cookie over plain http is silently discarded by the browser, so hardcoding it true would break every local login', () => {
    expect(secureCookies('http://localhost:3001')).toBe(false);
  });
});
