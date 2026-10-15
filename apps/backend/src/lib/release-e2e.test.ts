import { databaseSecretFrom } from './odoo-release.js';
import { describe, it, expect } from 'vitest';
import { readE2EReport } from './e2e.js';
import { PLAYWRIGHT_REPORT } from './e2e-fixtures.js';
import { ODOO_PLAYWRIGHT_CONFIG } from './project-templates.js';
import {
  E2E_LOGIN,
  QUIET_PREVIEW_SQL,
  RUNNER_SCRIPT,
  browserTestsJob,
  previewAddress,
  releaseE2EFrom,
  releaseSpecFiles,
  specConfigMap,
  testLoginJob,
  withConfig,
} from './release-e2e.js';

const PASSING = JSON.stringify({ suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ title: 'signs in', file: 'a.spec.ts', tests: [{ status: 'expected', results: [{ duration: 900 }] }] }] }], errors: [] });

describe('the browser tests a release runs against its preview', () => {
  it('takes every file under e2e/ and the project\'s Playwright config, and runs only when there is a spec', () => {
    expect(releaseSpecFiles(['README.md', 'playwright.config.ts', 'e2e/signs-in.spec.ts', 'e2e/helpers/login.ts', 'e2e/node_modules/x/index.js', 'addons/a/__manifest__.py'])).toEqual({
      specs: ['e2e/signs-in.spec.ts'],
      files: ['playwright.config.ts', 'e2e/helpers/login.ts', 'e2e/signs-in.spec.ts'],
    });
    expect(releaseSpecFiles(['e2e/helpers/login.ts']).specs).toEqual([]);
  });

  it('brings the scaffold\'s config when the project has none of its own', () => {
    expect(withConfig([{ path: 'e2e/a.spec.ts', content: 'x' }])).toEqual([{ path: 'playwright.config.ts', content: ODOO_PLAYWRIGHT_CONFIG }, { path: 'e2e/a.spec.ts', content: 'x' }]);
    expect(withConfig([{ path: 'playwright.config.ts', content: 'mine' }])).toEqual([{ path: 'playwright.config.ts', content: 'mine' }]);
  });

  it('hands the specs to the pod through a config map that puts each file back at its path', () => {
    const { manifest, items } = specConfigMap('shop', [{ path: 'playwright.config.ts', content: 'c' }, { path: 'e2e/a.spec.ts', content: 's' }]);
    expect(manifest).toMatchObject({ kind: 'ConfigMap', metadata: { name: 'shop-e2e' }, data: { f0: 'c', f1: 's' } });
    expect(items).toEqual([{ key: 'f0', path: 'playwright.config.ts' }, { key: 'f1', path: 'e2e/a.spec.ts' }]);
  });

  it('runs Playwright against the preview slot inside the cluster, signed in as the test login from the release\'s secret', () => {
    const job = browserTestsJob({ release: 'shop', slot: 'b', items: [{ key: 'f0', path: 'e2e/a.spec.ts' }] }) as { spec: { activeDeadlineSeconds?: number; template: { spec: { containers: { image: string; env: { name: string; value?: string; valueFrom?: unknown }[] }[]; volumes: unknown[] } } } };
    const container = job.spec.template.spec.containers[0]!;
    expect(container.image).toBe('mcr.microsoft.com/playwright:v1.48.2-noble');
    expect(container.env).toEqual(expect.arrayContaining([
      { name: 'BASE_URL', value: 'http://shop-odoo-b:8069' },
      { name: 'ODOO_LOGIN', value: E2E_LOGIN },
      { name: 'ODOO_PASSWORD', valueFrom: { secretKeyRef: { name: 'shop-e2e-login', key: 'password' } } },
    ]));
    expect(job.spec.template.spec.volumes).toEqual([{ name: 'specs', configMap: { name: 'shop-e2e', items: [{ key: 'f0', path: 'e2e/a.spec.ts' }] } }]);
    expect(job.spec.activeDeadlineSeconds).toBeUndefined();
    expect(previewAddress('shop', 'a')).toBe('http://shop-odoo-a:8069');
    expect(RUNNER_SCRIPT).toContain('npm install --no-save --no-audit --no-fund --loglevel=error @playwright/test@1.48.2');
    expect(RUNNER_SCRIPT).toContain('PLAYWRIGHT_JSON_OUTPUT_NAME=/work/e2e-results/report.json npx playwright test --reporter=line,json --output=/work/e2e-results/artifacts');
  });

  it('sets the test login up in the preview\'s own database with the build\'s image, its password never on the command line', () => {
    const job = testLoginJob({ release: 'shop', slot: 'b', image: 'reg/shop:two', database: 'odoo_b', password: { secret: 'shop-vault', key: 'POSTGRES_PASSWORD' } }) as { metadata: { name: string }; spec: { template: { spec: { containers: { image: string; command: string[]; env: { name: string; valueFrom?: unknown; value?: string }[] }[] } } } };
    const container = job.spec.template.spec.containers[0]!;
    expect(job.metadata.name).toBe('shop-e2e-login-b');
    expect(container.image).toBe('reg/shop:two');
    expect(container.command[2]).toContain('odoo shell --database=odoo_b --no-http --db_host=shop-postgres');
    expect(container.command.join(' ')).not.toMatch(/E2E_PASSWORD/);
    expect(container.env.find((entry) => entry.name === 'E2E_PASSWORD')).toEqual({ name: 'E2E_PASSWORD', valueFrom: { secretKeyRef: { name: 'shop-e2e-login', key: 'password' } } });
    expect(container.env.find((entry) => entry.name === 'SCRIPT')?.value).toContain('admin[groups].ids');
    expect(container.env.find((entry) => entry.name === 'PASSWORD')).toEqual({ name: 'PASSWORD', valueFrom: { secretKeyRef: { name: 'shop-vault', key: 'POSTGRES_PASSWORD' } } });
  });

  it('reads the database password from the vault once it holds one, and from a chart that keeps its own otherwise', () => {
    expect(databaseSecretFrom(['POSTGRES_PASSWORD', 'ODOO_ADMIN_PASSWORD'], 'shop')).toEqual({ secret: 'shop-vault', key: 'POSTGRES_PASSWORD' });
    expect(databaseSecretFrom([], 'shop')).toEqual({ secret: 'shop-secrets', key: 'postgres-password' });
  });

  it('quiets outgoing mail, scheduled jobs and incoming mail in a preview\'s copy', () => {
    expect(QUIET_PREVIEW_SQL).toContain('update ir_mail_server set active = false;');
    expect(QUIET_PREVIEW_SQL).toContain('update ir_cron set active = false;');
    expect(QUIET_PREVIEW_SQL).toContain('fetchmail_server');
  });

  it('passes only when every test passed and Playwright ended clean', () => {
    const times = { startedAt: 't0', finishedAt: 't1', artifacts: [], notKept: [], printed: '' };
    expect(releaseE2EFrom({ ...times, report: readE2EReport(PASSING), exit: 0 })).toMatchObject({ state: 'passed', summary: '1 passed, 0 failed', tests: [{ title: 'signs in', status: 'passed' }] });
    expect(releaseE2EFrom({ ...times, report: readE2EReport(PASSING), exit: 1, printed: 'Error: worker crashed' })).toMatchObject({ state: 'failed', reason: 'Playwright ended with exit 1:\nError: worker crashed' });
    expect(releaseE2EFrom({ ...times, report: readE2EReport(PLAYWRIGHT_REPORT), exit: 1, artifacts: [{ id: 'a1', name: 'x/test-failed-1.png' }] })).toMatchObject({
      state: 'failed',
      summary: '1 passed, 1 failed, 1 flaky, 1 skipped',
      artifacts: [{ id: 'a1', name: 'x/test-failed-1.png' }],
    });
    expect(releaseE2EFrom({ ...times, report: undefined, exit: 1, printed: 'Error: Cannot find module' })).toEqual({ state: 'failed', reason: 'the browser tests left no report:\nError: Cannot find module', startedAt: 't0', finishedAt: 't1' });
  });
});
