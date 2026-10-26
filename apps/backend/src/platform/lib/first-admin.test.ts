import { describe, it, expect } from 'vitest';
import { firstAdminSetup, setupCodeProblem } from './first-admin.js';

describe('the first admin\'s setup code', () => {
  it('takes the installer\'s code, and says so only while there is no account', () => {
    expect(firstAdminSetup({ ADMIN_SETUP_CODE: ' from-bootstrap ', NODE_ENV: 'production' }, true)).toEqual({ code: 'from-bootstrap', say: 'No account yet: the first sign-up becomes the admin with the setup code in ADMIN_SETUP_CODE' });
    expect(firstAdminSetup({ ADMIN_SETUP_CODE: 'from-bootstrap' }, false)).toEqual({ code: 'from-bootstrap', say: undefined });
  });

  it('makes one on a dev box and prints it, and lets nobody sign up on a production server without one', () => {
    expect(firstAdminSetup({}, true, () => 'made-here')).toEqual({ code: 'made-here', say: 'No account yet: sign up with the setup code made-here to become the admin' });
    expect(firstAdminSetup({ NODE_ENV: 'production' }, true)).toEqual({ code: undefined, say: 'No account yet, and ADMIN_SETUP_CODE is not set: nobody can sign up until it is' });
    expect(setupCodeProblem(undefined, 'anything')).toContain('no setup code is set');
  });

  it('takes only the exact code', () => {
    expect(setupCodeProblem('abc123', 'abc123')).toBeUndefined();
    expect(setupCodeProblem('abc123', 'abc12')).toContain('needs its setup code');
    expect(setupCodeProblem('abc123', undefined)).toContain('needs its setup code');
  });
});
