import { PLAYWRIGHT_VERSION, e2ePassed, e2eSummary, type E2EReport, type E2ETest } from './e2e.js';
import { E2E_RESULTS_DIR } from './artifacts.js';
import { releaseLabels, type Slot } from './odoo-release.js';
import { ODOO_PLAYWRIGHT_CONFIG } from './project-templates.js';

export const E2E_RUNNER_IMAGE = `mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble`;
export const E2E_DIR = 'e2e';
export const E2E_CONFIG = 'playwright.config.ts';
export const E2E_LOGIN = 'koala-e2e';
export const E2E_WORKDIR = '/work';
export const E2E_DONE = 'done';
export const E2E_INSTALL_FAILED = 'install';
export const MAX_SPEC_BYTES = 900 * 1024;

export type ReleaseE2EState = 'running' | 'passed' | 'failed' | 'unavailable' | 'stopped';

export interface ReleaseE2E {
  state: ReleaseE2EState;
  summary?: string | undefined;
  tests?: E2ETest[] | undefined;
  artifacts?: { id: string; name: string }[] | undefined;
  notKept?: string[] | undefined;
  reason?: string | undefined;
  startedAt: string;
  finishedAt?: string | undefined;
}

export const releaseE2EName = (release: string): string => `${release}-e2e`;
export const releaseLoginSecret = (release: string): string => `${release}-e2e-login`;
export const releaseLoginJobName = (release: string, slot: Slot): string => `${release}-e2e-login-${slot}`;
export const previewAddress = (release: string, slot: Slot): string => `http://${release}-odoo-${slot}:8069`;

export function releaseSpecFiles(paths: readonly string[]): { specs: string[]; files: string[] } {
  const files = paths
    .filter((path) => path.startsWith(`${E2E_DIR}/`) && !path.split('/').includes('node_modules'))
    .sort();
  const specs = files.filter((path) => /\.spec\.[cm]?[jt]s$/.test(path));
  return { specs, files: paths.includes(E2E_CONFIG) ? [E2E_CONFIG, ...files] : files };
}

export function withConfig(files: readonly { path: string; content: string }[]): { path: string; content: string }[] {
  return files.some((file) => file.path === E2E_CONFIG) ? [...files] : [{ path: E2E_CONFIG, content: ODOO_PLAYWRIGHT_CONFIG }, ...files];
}

export const specBytes = (files: readonly { content: string }[]): number =>
  files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);

export function specConfigMap(release: string, files: readonly { path: string; content: string }[]): { manifest: Record<string, unknown>; items: { key: string; path: string }[] } {
  const items = files.map((file, n) => ({ key: `f${n}`, path: file.path }));
  return {
    manifest: {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: releaseE2EName(release), labels: { ...releaseLabels(release), 'app.kubernetes.io/component': 'e2e' } },
      data: Object.fromEntries(files.map((file, n) => [`f${n}`, file.content])),
    },
    items,
  };
}

export const RUNNER_SCRIPT = [
  'set -u',
  `mkdir -p ${E2E_WORKDIR} && cd ${E2E_WORKDIR}`,
  `cp -rL /specs/${E2E_DIR} /specs/${E2E_CONFIG} ${E2E_WORKDIR}/`,
  `if ! npm install --no-save --no-audit --no-fund --loglevel=error @playwright/test@${PLAYWRIGHT_VERSION} > npm.log 2>&1; then`,
  `  echo ${E2E_INSTALL_FAILED} > ${E2E_DONE}.tmp && mv ${E2E_DONE}.tmp ${E2E_DONE}`,
  '  exec sleep infinity',
  'fi',
  'mkdir -p e2e-results',
  `PLAYWRIGHT_JSON_OUTPUT_NAME=${E2E_WORKDIR}/e2e-results/report.json npx playwright test --reporter=line,json --output=${E2E_WORKDIR}/${E2E_RESULTS_DIR} > run.log 2>&1`,
  `echo $? > ${E2E_DONE}.tmp && mv ${E2E_DONE}.tmp ${E2E_DONE}`,
  'exec sleep infinity',
].join('\n');

export function browserTestsJob(input: { release: string; slot: Slot; items: readonly { key: string; path: string }[] }): Record<string, unknown> {
  const labels = { ...releaseLabels(input.release), 'app.kubernetes.io/component': 'e2e' };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: releaseE2EName(input.release), labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'playwright',
            image: E2E_RUNNER_IMAGE,
            command: ['bash', '-c', RUNNER_SCRIPT],
            env: [
              { name: 'BASE_URL', value: previewAddress(input.release, input.slot) },
              { name: 'ODOO_LOGIN', value: E2E_LOGIN },
              { name: 'ODOO_PASSWORD', valueFrom: { secretKeyRef: { name: releaseLoginSecret(input.release), key: 'password' } } },
              { name: 'CI', value: '1' },
            ],
            resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '2Gi' } },
            volumeMounts: [{ name: 'specs', mountPath: '/specs', readOnly: true }],
          }],
          volumes: [{ name: 'specs', configMap: { name: releaseE2EName(input.release), items: input.items } }],
        },
      },
    },
  };
}

export function loginSecret(release: string, password: string): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: releaseLoginSecret(release), labels: { ...releaseLabels(release), 'app.kubernetes.io/component': 'e2e' } },
    type: 'Opaque',
    stringData: { password },
  };
}

export const LOGIN_SCRIPT = [
  'import os',
  'login = os.environ["E2E_LOGIN"]',
  'admin = env.ref("base.user_admin")',
  'Users = env["res.users"].with_context(active_test=False, no_reset_password=True)',
  'groups = "group_ids" if "group_ids" in Users._fields else "groups_id"',
  'values = {"name": "Koala browser tests", "login": login, "active": True, groups: [(6, 0, admin[groups].ids)]}',
  'user = Users.search([("login", "=", login)], limit=1) or Users.create(dict(values))',
  'user.write(values)',
  'user.write({"password": os.environ["E2E_PASSWORD"]})',
  'env.cr.commit()',
  'print("koala-e2e: the test login is ready")',
].join('\n');

export function testLoginJob(input: { release: string; slot: Slot; image: string; database: string; password: { secret: string; key: string } }): Record<string, unknown> {
  const labels = { ...releaseLabels(input.release), 'app.kubernetes.io/component': 'e2e' };
  const shell = `printf '%s\\n' "$SCRIPT" | odoo shell --database=${input.database} --no-http --db_host=${input.release}-postgres --db_user=odoo --db_password="$PASSWORD"`;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: releaseLoginJobName(input.release, input.slot), labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'odoo',
            image: input.image,
            command: ['sh', '-c', shell],
            env: [
              { name: 'PASSWORD', valueFrom: { secretKeyRef: { name: input.password.secret, key: input.password.key } } },
              { name: 'E2E_LOGIN', value: E2E_LOGIN },
              { name: 'E2E_PASSWORD', valueFrom: { secretKeyRef: { name: releaseLoginSecret(input.release), key: 'password' } } },
              { name: 'SCRIPT', value: LOGIN_SCRIPT },
            ],
          }],
        },
      },
    },
  };
}

export const QUIET_PREVIEW_SQL = [
  'update ir_mail_server set active = false;',
  'update ir_cron set active = false;',
  "do $$ begin if to_regclass('public.fetchmail_server') is not null then execute 'update fetchmail_server set active = false'; end if; end $$;",
].join(' ');

export function releaseE2EFrom(input: {
  report: E2EReport | undefined;
  exit: number;
  printed: string;
  artifacts: { id: string; name: string }[];
  notKept: string[];
  startedAt: string;
  finishedAt: string;
}): ReleaseE2E {
  const base = {
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    ...(input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
    ...(input.notKept.length > 0 ? { notKept: input.notKept } : {}),
  };
  if (!input.report) {
    return { ...base, state: 'failed', reason: `the browser tests left no report${input.printed ? `:\n${input.printed}` : ''}` };
  }
  const report = input.report;
  const summary = e2eSummary(report);
  if (e2ePassed(report) && input.exit === 0) return { ...base, state: 'passed', summary, tests: report.tests };
  const stray = report.failed === 0 && report.errors.length === 0 && input.exit !== 0
    ? `Playwright ended with exit ${input.exit}${input.printed ? `:\n${input.printed}` : ''}`
    : undefined;
  const reason = [...report.errors, ...(stray ? [stray] : [])].join('\n') || undefined;
  return { ...base, state: 'failed', summary, tests: report.tests, ...(reason ? { reason } : {}) };
}
