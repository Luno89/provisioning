import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';
import { withFailure, type Failures } from '../lib/audits.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

export default class FailureReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const file = process.env.KOALA_GATE_FAILURES;
    if (!file) return;
    const failed = modules.filter((module) => module.state() === 'failed').map((module) => relative(ROOT, module.moduleId));
    if (failed.length === 0) return;
    const at = new Date().toISOString();
    let failures: Failures = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Failures : {};
    for (const name of failed) failures = withFailure(failures, name, at);
    writeFileSync(file, `${JSON.stringify(failures, null, 1)}\n`);
  }
}
