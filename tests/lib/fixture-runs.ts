import type { RunningFile, RunStatus } from './test-runs.js';

export const MIN = 60_000;

export const aFile = (over: Partial<RunningFile> = {}): RunningFile => ({ file: 'apps/backend/src/infrastructure/routes/app-names.integration.test.ts', startedAt: 0, doing: 'afterAll', doingSince: 0, changedAt: 0, ...over });

export const aRun = (file: RunningFile, over: Partial<RunStatus> = {}): RunStatus => ({ pid: 7, checkout: '/c', workspace: 'apps/backend', startedAt: 0, files: { one: file }, ...over });
