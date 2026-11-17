import { describe, it, expect } from 'vitest';
import { ODOO_E2E_HELPERS } from './odoo-e2e-helpers.js';

describe('the Odoo helpers a spec signs in with', () => {
  it('a spec run outside odoo-e2e says how to run it, rather than signing in as admin', () => {
    const signIn = ODOO_E2E_HELPERS.slice(ODOO_E2E_HELPERS.indexOf('export async function signIn'), ODOO_E2E_HELPERS.indexOf('async function settled'));
    expect(signIn).not.toMatch(/\?\?\s*'admin'/);
    expect(signIn).toContain("throw new Error('ODOO_LOGIN and ODOO_PASSWORD are set by odoo-e2e; run the specs through it')");
    expect(signIn.indexOf('throw new Error')).toBeLessThan(signIn.indexOf("page.goto('/web/login')"));
  });
});
