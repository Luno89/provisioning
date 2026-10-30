import { describe, expect, it } from 'vitest';
import { DEV_INFISICAL_ADMIN_PASSWORD, infisicalAdminPassword } from './infisical-admin.js';

describe('Infisical\'s admin password', () => {
  it('is the one ensure-infisical.sh wrote', () => {
    expect(infisicalAdminPassword('  made-at-setup\n', true, '/data/.infisical-admin-password')).toBe('made-at-setup');
  });

  it('in production is never the development one: without the file Koala refuses to sign in', () => {
    for (const stored of [undefined, '', '  \n']) {
      expect(() => infisicalAdminPassword(stored, true, '/data/.infisical-admin-password'))
        .toThrow('Infisical\'s admin password is not in /data/.infisical-admin-password. In production Koala never signs in to Infisical with the development password');
    }
  });

  it('on a dev box falls back to the development one', () => {
    expect(infisicalAdminPassword(undefined, false, '/data/.infisical-admin-password')).toBe(DEV_INFISICAL_ADMIN_PASSWORD);
  });
});
