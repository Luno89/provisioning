import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_LOGIN, LOGIN_SCRIPT } from '../../lib/release-e2e.js';
import { ODOO_E2E_SCRIPT } from './odoo-e2e.js';

describe('odoo-e2e', () => {
  it('signs specs in as the same test user a preview does, made with the admin\'s rights before the tests run', () => {
    expect(ODOO_E2E_SCRIPT).toContain(`ODOO_LOGIN=${E2E_LOGIN} ODOO_PASSWORD=${E2E_LOGIN}`);
    expect(ODOO_E2E_SCRIPT).not.toContain('ODOO_LOGIN=admin');
    expect(ODOO_E2E_SCRIPT).toContain(LOGIN_SCRIPT);
    expect(ODOO_E2E_SCRIPT.indexOf('the test login is ready')).toBeLessThan(ODOO_E2E_SCRIPT.indexOf('playwright test'));
  });

  it('is a script sh can read', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'odoo-e2e-')), 'odoo-e2e');
    writeFileSync(file, ODOO_E2E_SCRIPT);
    expect(() => execFileSync('sh', ['-n', file])).not.toThrow();
  });
});
