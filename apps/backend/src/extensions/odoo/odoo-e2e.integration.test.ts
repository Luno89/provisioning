import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_IGNORED } from '../../engine/lib/e2e.js';
import { E2E_LOGIN, LOGIN_SCRIPT } from '../../releases/lib/release-e2e.js';
import { ODOO_E2E_LOGIN_STEP, ODOO_E2E_SCRIPT } from './odoo-e2e.js';

describe('odoo-e2e', () => {
  it('signs specs in as the same test user a preview does, made with the admin\'s rights before the tests run', () => {
    expect(ODOO_E2E_SCRIPT).toContain(`ODOO_LOGIN=${E2E_LOGIN} ODOO_PASSWORD=${E2E_LOGIN}`);
    expect(ODOO_E2E_SCRIPT).not.toContain('ODOO_LOGIN=admin');
    expect(ODOO_E2E_SCRIPT).toContain(LOGIN_SCRIPT);
    expect(ODOO_E2E_SCRIPT.indexOf('the test login is ready')).toBeLessThan(ODOO_E2E_SCRIPT.indexOf('playwright test'));
  });

  it('keeps its results out of git before it writes them', () => {
    expect(ODOO_E2E_SCRIPT.indexOf(E2E_IGNORED)).toBeGreaterThan(-1);
    expect(ODOO_E2E_SCRIPT.indexOf(E2E_IGNORED)).toBeLessThan(ODOO_E2E_SCRIPT.indexOf('mkdir -p "$PWD/e2e-results"'));
  });

  it('stops with its reason when the test login cannot be made, before any spec runs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'odoo-e2e-login-'));
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'odoo'), '#!/bin/sh\ncat >/dev/null\necho "psycopg2.OperationalError: the database is not there"\nexit 3\n', { mode: 0o755 });
    const script = path.join(dir, 'login.sh');
    writeFileSync(script, `set -eu\nstate=${JSON.stringify(dir)}\nreused=0\ncommon=''\n${ODOO_E2E_LOGIN_STEP}\necho "the specs would run now"\n`);
    const ran = spawnSync('sh', [script], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH ?? ''}` } });
    expect(ran.status).toBe(1);
    expect(ran.stdout).toContain('psycopg2.OperationalError: the database is not there');
    expect(ran.stdout).toContain(`odoo-e2e: FAILED — the test login ${E2E_LOGIN} could not be made (odoo shell exited 3)`);
    expect(ran.stdout).not.toContain('the specs would run now');
    expect(ODOO_E2E_SCRIPT).toContain(ODOO_E2E_LOGIN_STEP);
  });

  it('is a script sh can read', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'odoo-e2e-')), 'odoo-e2e');
    writeFileSync(file, ODOO_E2E_SCRIPT);
    expect(() => execFileSync('sh', ['-n', file])).not.toThrow();
  });
});
