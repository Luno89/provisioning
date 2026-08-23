import { describe, it, expect, afterEach } from 'vitest';
import { mockOAuthAllowed } from './oauth-gate.js';

/**
 * Guards the mock OAuth flow against being reachable in production.
 *
 * The mock logs in as a fixed identity with no credential whatsoever, and the first user to exist
 * becomes admin — so a reachable mock on a deployed host is an unauthenticated admin login.
 *
 * Two separate holes existed, and the second is the one worth remembering: the callback's only
 * guard was `code !== 'mock-<provider>-code'`. That value arrives in the query string, so
 * requesting the callback directly with it skipped the token exchange and logged the caller in as
 * the mock user EVEN WITH OAUTH FULLY CONFIGURED. Configuring Google did not close it.
 *
 * The rule is asserted here rather than only in index.ts because it is one line that silently
 * turns into a full account takeover if anyone "simplifies" it back to a client-id check.
 */
const original = process.env.NODE_ENV;
afterEach(() => {
  if (original === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original;
});

describe('mock OAuth gate', () => {
  it('is closed in production', () => {
    process.env.NODE_ENV = 'production';
    expect(mockOAuthAllowed()).toBe(false);
  });

  it('stays closed in production even with OAuth fully configured', () => {
    // The original bug in one line: the gate must not depend on whether a client id is set.
    // Keying off configuration means a production host with missing config fails OPEN.
    process.env.NODE_ENV = 'production';
    process.env.GOOGLE_CLIENT_ID = 'real-id';
    process.env.GOOGLE_CLIENT_SECRET = 'real-secret';
    expect(mockOAuthAllowed()).toBe(false);
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  it('is open in development, which is the only reason it exists', () => {
    process.env.NODE_ENV = 'development';
    expect(mockOAuthAllowed()).toBe(true);
  });

  it('is open when NODE_ENV is unset — a bare `npm run dev`', () => {
    delete process.env.NODE_ENV;
    expect(mockOAuthAllowed()).toBe(true);
  });
});
