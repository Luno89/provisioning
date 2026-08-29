import { describe, it, expect, afterEach } from 'vitest';
import { mockOAuthAllowed } from './oauth-gate.js';

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
