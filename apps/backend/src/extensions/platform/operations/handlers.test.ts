import { describe, it, expect } from 'vitest';
import type { NodeRequest } from '@koala/agent-engine/procedure';
import type { EnvironmentDriver, ExecResult } from '@koala/engine-core';
import { createPlatformOperations, type PlatformOperationDeps } from './handlers.js';
import { PLAYWRIGHT_REPORT } from '../../../lib/e2e-fixtures.js';

const PASSING = JSON.stringify({ suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ title: 'signs in', file: 'a.spec.ts', tests: [{ status: 'expected', results: [{ status: 'passed', duration: 900 }] }] }] }], errors: [] });
const SHOT = Buffer.from('png-bytes');

interface World { exitCode?: number; stdout?: string; report?: string | undefined; shots?: boolean }

function workspace(world: World) {
  const ran: { command: string; timeoutMs?: number | undefined }[] = [];
  const reply = (stdout = '', exitCode = 0): ExecResult => ({ stdout, stderr: '', exitCode });
  const driver = {
    exec: async ({ command, timeoutMs }: { command: string; timeoutMs?: number }) => {
      ran.push({ command, timeoutMs });
      if (command.startsWith('find e2e-results/artifacts')) return reply(world.shots ? `${SHOT.length} e2e-results/artifacts/probe-sees/test-failed-1.png\n` : '');
      if (command.startsWith('tail -c')) return reply(SHOT.toString('base64'));
      return reply(world.stdout ?? '', world.exitCode ?? 0);
    },
    readFile: async (path: string) => {
      if (path === 'e2e-results/report.json' && world.report !== undefined) return world.report;
      throw new Error(`no ${path}`);
    },
  } as unknown as EnvironmentDriver;
  return { driver, ran };
}

const request = (settings: Record<string, unknown>, inputs: Record<string, unknown> = {}): NodeRequest => ({
  node: { id: 'e2e', kind: 'host-op', settings: { operation: 'platform.run-e2e', ...settings }, position: { x: 0, y: 0 } },
  origin: 'e2e',
  inputs,
  execution: 1,
  run: {
    identity: { runId: 'run-e', depth: 0, agentId: 'executor', loopId: 'p', loopVersion: '1', trigger: 'user' },
    launch: { ownerId: 'user-1' },
    handles: new Set(),
    inputs: {},
    counters: {} as never,
    budget: {},
    cleaningUp: false,
    emit: () => undefined,
  },
} as never);

function setUp(world: World, driverMissing = false) {
  const { driver, ran } = workspace(world);
  const asked: unknown[] = [];
  const kept: { ownerId: string; runId: string; names: string[] }[] = [];
  const deps: PlatformOperationDeps = {
    environments: { forRun: async (forRun) => { asked.push(forRun); return driverMissing ? undefined : driver; } },
    artifacts: {
      keep: async (ownerId, runId, files) => {
        kept.push({ ownerId, runId, names: files.map((file) => file.name) });
        return { stored: files.map((file, index) => ({ id: `a${index}`, name: file.name })), dropped: [], minioMissing: true };
      },
    },
  };
  const run = (settings: Record<string, unknown> = {}, inputs: Record<string, unknown> = {}) =>
    createPlatformOperations(deps)['platform.run-e2e']!(request(settings, inputs)) as Promise<{ exit: string; outputs: Record<string, unknown> }>;
  return { run, ran, asked, kept };
}

describe('Run Browser Tests', () => {
  it('serves the workspace\'s own app and leaves by passed with the report', async () => {
    const { run, ran, asked } = setUp({ report: PASSING });
    const result = await run({ specs: ['e2e/a.spec.ts'] });

    expect(result.exit).toBe('passed');
    expect(result.outputs).toMatchObject({ summary: '1 passed, 0 failed', artifacts: [], report: { passed: 1, failed: 0 } });
    expect(ran[0]).toEqual({ command: `rm -rf e2e-results && mkdir -p e2e-results && koala-e2e 'e2e/a.spec.ts'`, timeoutMs: 15 * 60_000 });
    expect(asked[0]).toMatchObject({ ticket: { runId: 'run-e', ownerId: 'user-1' } });
  });

  it('takes its time limit and runs in the environment it is handed', async () => {
    const { run, ran, asked } = setUp({ report: PASSING });
    const environment = { kind: 'sandbox', id: 'env-1', capabilities: { terminal: true }, egress: false };
    await run({ minutes: 3 }, { environment });

    expect(ran[0]!.timeoutMs).toBe(3 * 60_000);
    expect(ran[0]!.command).toContain(`koala-e2e 'e2e'`);
    expect(asked[0]).toMatchObject({ environment: { id: 'env-1' } });
  });

  it('leaves by failed, naming each failed test and keeping what the browser left behind', async () => {
    const { run, kept } = setUp({ report: PLAYWRIGHT_REPORT, exitCode: 1, shots: true });
    const result = await run();

    expect(result.exit).toBe('failed');
    expect(kept).toEqual([{ ownerId: 'user-1', runId: 'run-e', names: ['probe-sees/test-failed-1.png'] }]);
    expect(result.outputs.artifacts).toEqual([{ id: 'a0', name: 'probe-sees/test-failed-1.png', url: '/api/artifacts/a0' }]);
    const summary = String(result.outputs.summary);
    expect(summary).toContain('1 passed, 1 failed, 1 flaky, 1 skipped');
    expect(summary).toContain('FAILED — sees the field (probe.spec.ts): Error: expect(locator).toBeVisible() failed');
    expect(summary).toContain('![probe-sees/test-failed-1.png](/api/artifacts/a0)');
  });

  it('leaves by failed with what was printed when the app never came up', async () => {
    const { run } = setUp({ exitCode: 1, stdout: 'koala-e2e: FAILED — there is no module under addons/ to serve' });
    const result = await run();

    expect(result).toEqual({ exit: 'failed', outputs: expect.objectContaining({ reason: 'the browser tests against the workspace\'s own app left no report — it exited 1: koala-e2e: FAILED — there is no module under addons/ to serve' }) });
  });

  it('is unavailable where the image has no runner, or there is no workspace', async () => {
    expect((await setUp({ exitCode: 127 }).run()).outputs.reason).toBe('this workspace\'s image has no koala-e2e, so it cannot serve its app to a browser');
    expect((await setUp({ exitCode: 127 }).run({ url: 'http://shop.local' })).outputs.reason).toBe('this workspace has no Playwright to run them with');
    expect(await setUp({}, true).run()).toEqual({ exit: 'unavailable', outputs: { reason: 'this run has no workspace to run browser tests in' } });
  });

  it('refuses an address that carries a login, and runs nothing', async () => {
    const { run, ran } = setUp({ report: PASSING });
    expect(await run({ url: 'https://admin:pw@shop.example' })).toEqual({ exit: 'unavailable', outputs: { reason: 'a browser test address cannot carry a login: the workspace\'s agent could read it' } });
    expect(ran).toEqual([]);
  });

  it('runs Playwright at an address that needs no login', async () => {
    const { run, ran } = setUp({ report: PASSING });
    expect((await run({ url: 'http://shop.local:8069', specs: ['e2e/a.spec.ts'] })).exit).toBe('passed');
    expect(ran[0]!.command).toContain(`BASE_URL='http://shop.local:8069'`);
  });
});
