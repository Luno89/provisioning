import { describe, expect, it } from 'vitest';
import { sessionCookieFrom } from './check-session.js';

describe('the session a check carries on after signing out everywhere', () => {
  it('takes the new session cookie the answer sets, by either name', () => {
    expect(sessionCookieFrom(['device=abc; Path=/', 'session=new-token; HttpOnly; Path=/'])).toBe('session=new-token');
    expect(sessionCookieFrom('__Host-session=new-token; Secure; Path=/')).toBe('session=new-token');
  });

  it('finds none when the answer sets no session', () => {
    expect(sessionCookieFrom(['device=abc; Path=/'])).toBeUndefined();
    expect(sessionCookieFrom(undefined)).toBeUndefined();
  });
});
