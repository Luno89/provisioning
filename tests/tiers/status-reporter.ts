import { relative, resolve } from 'node:path';
import type { Reporter, TestModule, Vitest } from 'vitest/node';
import type { UserConsoleLog } from 'vitest';
import { doing, dropStatus, GROUP, RUN_PID, heard, keepStatus, runsDir, type RunningFile, type RunStatus } from '../lib/test-runs.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

export default class StatusReporter implements Reporter {
  private vitest: Vitest | undefined;
  private readonly dir = runsDir();
  private status: RunStatus | undefined;
  private readonly ended = new Set<string>();

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
    const group = process.env[GROUP];
    this.status = { pid: process.pid, checkout: ROOT, workspace: relative(ROOT, vitest.config.root) || '.', ...(group ? { group } : {}), startedAt: Date.now(), files: {} };
    process.env[RUN_PID] = String(process.pid);
    keepStatus(this.dir, this.status);
    process.once('exit', () => dropStatus(this.dir, process.pid));
  }

  onTestModuleQueued(module: TestModule): void {
    this.change(module, (file) => file);
  }

  onTestModuleStart(module: TestModule): void {
    this.change(module, (file) => (file.doing === 'loading' ? doing(file, 'starting', Date.now()) : file));
  }

  onUserConsoleLog(log: UserConsoleLog): void {
    if (!log.taskId) return;
    const entity = this.vitest?.state.getReportedEntityById(log.taskId);
    if (!entity) return;
    this.change(entity.type === 'module' ? entity : entity.module, (file) => heard(file, log.content, Date.now()));
  }

  onTestModuleEnd(module: TestModule): void {
    this.ended.add(module.id);
    if (!this.status) return;
    const { [module.id]: ended, ...rest } = this.status.files;
    if (!ended) return;
    this.status = { ...this.status, files: rest };
    keepStatus(this.dir, this.status);
  }

  onTestRunEnd(): void {
    this.ended.clear();
    if (!this.status) return;
    this.status = { ...this.status, files: {} };
    dropStatus(this.dir, process.pid);
  }

  private change(module: TestModule, next: (file: RunningFile) => RunningFile): void {
    if (!this.status || this.ended.has(module.id)) return;
    const now = Date.now();
    const before = this.status.files[module.id];
    const after = next(before ?? { file: relative(ROOT, module.moduleId), startedAt: now, doing: 'loading', doingSince: now, changedAt: now });
    if (after === before) return;
    this.status = { ...this.status, files: { ...this.status.files, [module.id]: after } };
    keepStatus(this.dir, this.status);
  }
}
