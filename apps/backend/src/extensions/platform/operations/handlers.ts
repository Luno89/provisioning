import type { NodeRequest, StepResult } from '@koala/agent-engine/procedure';
import type { EnvironmentDriver } from '@koala/engine-core';
import type { HostOperationRun } from '../../types.js';
import { handleFor, ticketFor, type EnvironmentHandleRef, type RunEnvironment, type RunTicket } from '../../../engine-host/temporal/contracts.js';
import { keepFailureArtifacts, type KeepArtifacts } from '../../../lib/artifacts.js';
import {
  E2E_REPORT,
  E2E_RUNNER,
  E2E_RUNNER_MISSING,
  E2E_TIMEOUT_MS,
  e2eCommand,
  e2ePassed,
  e2eRequestOf,
  e2eSummary,
  e2eTarget,
  e2eUrlProblem,
  printedTail,
  readE2EReport,
  type E2EReport,
} from '../../../lib/e2e.js';

export interface PlatformOperationDeps {
  environments: { forRun(request: { ticket: RunTicket; environment?: EnvironmentHandleRef | undefined }): Promise<EnvironmentDriver | undefined> };
  artifacts?: { keep: KeepArtifacts } | undefined;
}

const unavailable = (reason: string): StepResult => ({ exit: 'unavailable', outputs: { reason } });

function failedLines(report: E2EReport): string[] {
  return report.tests
    .filter((test) => test.status === 'failed')
    .map((test) => `FAILED — ${test.title} (${test.file}): ${test.error ?? 'Playwright gave no reason'}`);
}

export function createPlatformOperations(deps: PlatformOperationDeps): Record<string, HostOperationRun> {
  return {
    async 'platform.run-e2e'(request: NodeRequest): Promise<StepResult> {
      const { settings } = request.node;
      const url = typeof settings.url === 'string' ? settings.url.trim() : '';
      if (url && e2eUrlProblem(url)) return unavailable(e2eUrlProblem(url)!);
      const asked = e2eRequestOf({ specs: settings.specs, ...(url ? { url } : {}) })!;
      const minutes = typeof settings.minutes === 'number' && settings.minutes > 0 ? settings.minutes : E2E_TIMEOUT_MS / 60_000;

      const environment = handleFor(request.inputs.environment as RunEnvironment | undefined);
      let driver: EnvironmentDriver | undefined;
      try {
        driver = await deps.environments.forRun({ ticket: ticketFor(request.run), ...(environment ? { environment } : {}) });
      } catch (err) {
        return unavailable(`the workspace could not be reached: ${(err as Error).message}`);
      }
      if (!driver) return unavailable('this run has no workspace to run browser tests in');

      const ran = await driver.exec({ command: e2eCommand(asked), timeoutMs: minutes * 60_000 });
      if (ran.exitCode === E2E_RUNNER_MISSING) {
        return unavailable(asked.url ? 'this workspace has no Playwright to run them with' : `this workspace's image has no ${E2E_RUNNER}, so it cannot serve its app to a browser`);
      }

      const report = readE2EReport(await driver.readFile(E2E_REPORT).catch(() => undefined));
      if (!report) {
        const why = `the browser tests against ${e2eTarget(asked)} left no report — it exited ${ran.exitCode}: ${printedTail(ran) || 'no output'}`;
        return { exit: 'failed', outputs: { summary: why, reason: why, artifacts: [] } };
      }
      if (e2ePassed(report) && ran.exitCode === 0) {
        return { exit: 'passed', outputs: { report, summary: e2eSummary(report), artifacts: [] } };
      }

      const workspace = { exec: (command: string) => driver.exec({ command, timeoutMs: 60_000 }) };
      const kept = deps.artifacts
        ? await keepFailureArtifacts(workspace, deps.artifacts.keep, request.run.launch.ownerId, request.run.identity.runId)
        : { lines: '', stored: [] };
      const stray = report.failed === 0 ? [`it exited ${ran.exitCode}: ${[...report.errors, printedTail(ran)].filter(Boolean).join('\n') || 'no output'}`] : [];
      return {
        exit: 'failed',
        outputs: {
          report,
          summary: [e2eSummary(report), ...failedLines(report), ...stray, kept.lines].filter(Boolean).join('\n'),
          artifacts: kept.stored.map((artifact) => ({ id: artifact.id, name: artifact.name, url: `/api/artifacts/${artifact.id}` })),
        },
      };
    },
  };
}
