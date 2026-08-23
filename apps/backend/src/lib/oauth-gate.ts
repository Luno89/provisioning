/**
 * Whether the mock OAuth flow may run.
 *
 * ── WHY ONE LINE GETS ITS OWN FILE ──
 * The mock logs in as a fixed identity with no credential whatsoever, and the first user to exist
 * becomes admin — so a reachable mock on a deployed host is an unauthenticated admin login.
 *
 * Two separate holes existed, and the second is the one worth remembering: the callback's only
 * guard was `code !== 'mock-<provider>-code'`. That value arrives in the query string, so
 * requesting the callback directly with it skipped the token exchange and logged the caller in as
 * the mock user EVEN WITH OAUTH FULLY CONFIGURED. Configuring Google did not close it.
 *
 * So the gate keys off the ENVIRONMENT and nothing else. Keying off whether a client id is set
 * means a production host with missing config fails OPEN, which is the same bug wearing a hat.
 *
 * It lives here rather than inline in index.ts because `lib/oauth-mock-gate.test.ts` used to assert
 * a copy of it — a test that imported nothing but vitest and would have passed forever regardless
 * of what the server actually did.
 */
export function mockOAuthAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}
