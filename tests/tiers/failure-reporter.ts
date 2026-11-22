import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';
import { withFailure, type Failures } from '../lib/audits.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

export function whyFailed(module: TestModule): string {
  const ofFile = module.errors().map((error) => error.message);
  const ofTests = [...module.children.allTests('failed')].flatMap((test) => (test.result().errors ?? []).map((error) => `${test.fullName}: ${error.message}`));
  return [...ofFile, ...ofTests].join('\n');
}

export default class FailureReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const file = process.env.KOALA_GATE_FAILURES;
    if (!file) return;
    const failed = modules.filter((module) => module.state() === 'failed');
    if (failed.length === 0) return;
    const at = new Date().toISOString();
    let failures: Failures = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Failures : {};
    for (const module of failed) failures = withFailure(failures, relative(ROOT, module.moduleId), { at, why: whyFailed(module) });
    writeFileSync(file, `${JSON.stringify(failures, null, 1)}\n`);
  }
}
