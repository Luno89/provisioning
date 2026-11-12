import { relative, resolve } from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';
import { keepTimings, overBudget, type Tier } from '../lib/timings.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

export default class TimingReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const tests = modules.flatMap((module) => {
      const tier: Tier = module.project.name === 'integration' ? 'integration' : 'unit';
      const file = relative(ROOT, module.moduleId);
      return [...module.children.allTests()].filter((test) => test.result().state === 'passed').map((test) => ({
        name: `${file} > ${test.fullName}`, tier, seconds: (test.diagnostic()?.duration ?? 0) / 1000,
      }));
    });
    const slow = overBudget(tests);
    if (slow.length > 0) console.log(`\ntests that took longer than they may:\n${slow.map((line) => `  ${line}`).join('\n')}`);
    const timings = process.env.KOALA_GATE_TIMINGS;
    const commit = process.env.KOALA_GATE_COMMIT;
    if (!timings || !commit) return;
    const at = new Date().toISOString();
    keepTimings(timings, [
      ...modules.filter((module) => module.state() === 'passed').map((module) => ({ at, commit, kind: 'file' as const, name: relative(ROOT, module.moduleId), seconds: module.diagnostic().duration / 1000 })),
      ...tests.map((test) => ({ at, commit, kind: 'test' as const, name: test.name, seconds: test.seconds })),
    ]);
  }
}
