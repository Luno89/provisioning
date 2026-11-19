import { relative, resolve } from 'node:path';
import type { ReportedHookContext, Reporter, TestCase, TestModule, Vitest } from 'vitest/node';
import type { UserConsoleLog } from 'vitest';
import { doing, dropStatus, GROUP, heard, keepStatus, runsDir, type RunningFile, type RunStatus } from '../lib/test-runs.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

const named = (fullName: string): string => fullName.replaceAll(' > ', ' › ');

export default class StatusReporter implements Reporter {
  private vitest: Vitest | undefined;
  private readonly dir = runsDir();
  private status: RunStatus | undefined;

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
    const group = process.env[GROUP];
    this.status = { pid: process.pid, checkout: ROOT, workspace: relative(ROOT, vitest.config.root) || '.', ...(group ? { group } : {}), startedAt: Date.now(), files: {} };
    keepStatus(this.dir, this.status);
    process.once('exit', () => dropStatus(this.dir, process.pid));
  }

  onTestModuleQueued(module: TestModule): void {
    const now = Date.now();
    this.change(module.id, () => ({ file: relative(ROOT, module.moduleId), startedAt: now, doing: 'loading', doingSince: now, changedAt: now }));
  }

  onTestModuleStart(module: TestModule): void {
    this.move(module.id, 'starting');
  }

  onTestCaseReady(test: TestCase): void {
    this.move(test.module.id, named(test.fullName));
  }

  onHookStart(hook: ReportedHookContext): void {
    const entity = hook.entity;
    this.move(entity.type === 'module' ? entity.id : entity.module.id, entity.type === 'module' ? hook.name : `${named(entity.fullName)} › ${hook.name}`);
  }

  onUserConsoleLog(log: UserConsoleLog): void {
    if (!log.taskId) return;
    const entity = this.vitest?.state.getReportedEntityById(log.taskId);
    if (!entity) return;
    const id = entity.type === 'module' ? entity.id : entity.module.id;
    this.change(id, (file) => (file ? heard(file, log.content, Date.now()) : undefined));
  }

  onTestModuleEnd(module: TestModule): void {
    if (!this.status) return;
    const { [module.id]: ended, ...rest } = this.status.files;
    if (!ended) return;
    this.status = { ...this.status, files: rest };
    keepStatus(this.dir, this.status);
  }

  onTestRunEnd(): void {
    if (!this.status) return;
    this.status = { ...this.status, files: {} };
    dropStatus(this.dir, process.pid);
  }

  private move(id: string, what: string): void {
    this.change(id, (file) => (file ? doing(file, what, Date.now()) : undefined));
  }

  private change(id: string, next: (file: RunningFile | undefined) => RunningFile | undefined): void {
    if (!this.status) return;
    const before = this.status.files[id];
    const after = next(before);
    if (!after || after === before) return;
    this.status = { ...this.status, files: { ...this.status.files, [id]: after } };
    keepStatus(this.dir, this.status);
  }
}
