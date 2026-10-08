import { E2E_RESULTS_DIR } from './artifacts.js';

export const E2E_RUNNER = 'koala-e2e';
export const E2E_ROOT = 'e2e-results';
export const E2E_REPORT = `${E2E_ROOT}/report.json`;
export const E2E_DEFAULT_SPECS = ['e2e'];
export const E2E_TIMEOUT_MS = 15 * 60_000;
export const E2E_RUNNER_MISSING = 127;

export type E2ETestStatus = 'passed' | 'failed' | 'flaky' | 'skipped';

export interface E2ETest {
  title: string;
  file: string;
  status: E2ETestStatus;
  durationMs: number;
  error?: string | undefined;
}

export interface E2EReport {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  tests: E2ETest[];
  errors: string[];
}

export interface E2ERequest {
  specs: string[];
  url?: string | undefined;
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim();

export function e2eUrlProblem(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url}" is not an address a browser can open`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `"${url}" has to be an http or https address`;
  if (parsed.username || parsed.password) return 'a browser test address cannot carry a login: the workspace\'s agent could read it';
  return undefined;
}

export function e2eRequestOf(raw: unknown): E2ERequest | undefined {
  if (raw === true) return { specs: [...E2E_DEFAULT_SPECS] };
  const given = Array.isArray(raw) || typeof raw === 'string' ? { specs: raw } : raw;
  if (!given || typeof given !== 'object') return undefined;
  const record = given as Record<string, unknown>;
  const listed = typeof record.specs === 'string' ? record.specs.split(/[\s,]+/) : Array.isArray(record.specs) ? record.specs : [];
  const specs = listed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
  const url = typeof record.url === 'string' && record.url.trim() ? record.url.trim() : undefined;
  if (url && e2eUrlProblem(url)) return undefined;
  return { specs: specs.length > 0 ? specs : [...E2E_DEFAULT_SPECS], ...(url ? { url } : {}) };
}

export function e2eCommand(request: E2ERequest): string {
  const specs = request.specs.map(quote).join(' ');
  const fresh = `rm -rf ${E2E_ROOT} && mkdir -p ${E2E_ROOT}`;
  if (!request.url) return `${fresh} && ${E2E_RUNNER} ${specs}`;
  return [
    `command -v playwright >/dev/null || exit ${E2E_RUNNER_MISSING};`,
    `${fresh} && BASE_URL=${quote(request.url)} PLAYWRIGHT_JSON_OUTPUT_NAME="$PWD/${E2E_REPORT}"`,
    `playwright test ${specs} --reporter=line,json --output="$PWD/${E2E_RESULTS_DIR}"`,
  ].join(' ');
}

export function e2eTarget(request: E2ERequest): string {
  return request.url ? request.url : 'the workspace\'s own app';
}

interface ReportResult { status?: string; duration?: number; error?: { message?: string }; errors?: { message?: string }[] }
interface ReportTest { status?: string; results?: ReportResult[] }
interface ReportSpec { title?: string; file?: string; tests?: ReportTest[] }
interface ReportSuite { title?: string; file?: string; specs?: ReportSpec[]; suites?: ReportSuite[] }

const STATUS: Record<string, E2ETestStatus> = { expected: 'passed', unexpected: 'failed', flaky: 'flaky', skipped: 'skipped' };

function errorOf(results: readonly ReportResult[]): string | undefined {
  const last = results.at(-1);
  const message = last?.error?.message ?? last?.errors?.find((entry) => entry.message)?.message;
  return message ? plain(message).slice(0, 600) : undefined;
}

function testsOf(suite: ReportSuite, path: readonly string[], top: boolean): E2ETest[] {
  const here = top ? path : [...path, suite.title ?? ''].filter(Boolean);
  const own = (suite.specs ?? []).flatMap((spec) => (spec.tests ?? []).map((test): E2ETest => {
    const results = test.results ?? [];
    const error = errorOf(results);
    return {
      title: [...here, spec.title ?? ''].filter(Boolean).join(' › '),
      file: spec.file ?? suite.file ?? '',
      status: STATUS[test.status ?? ''] ?? 'failed',
      durationMs: results.reduce((sum, result) => sum + (result.duration ?? 0), 0),
      ...(error && test.status !== 'expected' ? { error } : {}),
    };
  }));
  return [...own, ...(suite.suites ?? []).flatMap((child) => testsOf(child, here, false))];
}

export function readE2EReport(text: string | undefined): E2EReport | undefined {
  if (!text?.trim()) return undefined;
  let parsed: { suites?: ReportSuite[]; errors?: { message?: string }[] };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const tests = (parsed.suites ?? []).flatMap((suite) => testsOf(suite, [], true));
  const count = (status: E2ETestStatus) => tests.filter((test) => test.status === status).length;
  return {
    passed: count('passed'),
    failed: count('failed'),
    flaky: count('flaky'),
    skipped: count('skipped'),
    tests,
    errors: (parsed.errors ?? []).map((entry) => plain(entry.message ?? '')).filter(Boolean),
  };
}

export const e2ePassed = (report: E2EReport): boolean =>
  report.failed === 0 && report.errors.length === 0 && report.passed + report.flaky > 0;

export function e2eSummary(report: E2EReport): string {
  const parts = [`${report.passed} passed`, `${report.failed} failed`];
  if (report.flaky > 0) parts.push(`${report.flaky} flaky`);
  if (report.skipped > 0) parts.push(`${report.skipped} skipped`);
  if (report.passed + report.failed + report.flaky + report.skipped === 0) parts.push('no tests ran');
  return parts.join(', ');
}

export function printedTail(outcome: { stdout: string; stderr: string }): string {
  return [plain(outcome.stdout).split('\n').slice(-12).join('\n'), plain(outcome.stderr)].filter(Boolean).join('\n').slice(-1200);
}
