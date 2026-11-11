import { relative, resolve } from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';
import { keepTimings } from '../lib/timings.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

export default class TimingReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const file = process.env.KOALA_GATE_TIMINGS;
    const commit = process.env.KOALA_GATE_COMMIT;
    if (!file || !commit) return;
    const at = new Date().toISOString();
    keepTimings(file, modules.filter((module) => module.state() === 'passed').map((module) => ({ at, commit, kind: 'file' as const, name: relative(ROOT, module.moduleId), seconds: module.diagnostic().duration / 1000 })));
  }
}
