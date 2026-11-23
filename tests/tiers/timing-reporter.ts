import { relative, resolve } from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';
import { judgeTests, KNOWN_SLOW, readSlow, SLOW_LIST, SLOW_LIST_FROM } from '../lib/slow.js';
import { keepTimings, tierOf } from '../lib/timings.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

const lines = (lines: readonly string[]): string => lines.map((line) => `  ${line}`).join('\n');

export default class TimingReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const tests = modules.flatMap((module) => {
      const tier = tierOf(module.project.name);
      const file = relative(ROOT, module.moduleId);
      return [...module.children.allTests()].filter((test) => test.result().state === 'passed').map((test) => ({
        name: `${file} > ${test.fullName}`, tier, seconds: (test.diagnostic()?.duration ?? 0) / 1000,
      }));
    });
    const judged = judgeTests(tests, readSlow(process.env[SLOW_LIST_FROM] ?? SLOW_LIST), modules.map((module) => relative(ROOT, module.moduleId)));
    if (judged.failing.length > 0) {
      console.log(`\ntests over budget:\n${lines(judged.failing)}`);
      process.exitCode = 1;
    }
    if (judged.known.length > 0) console.log(`\ntests over budget, ${KNOWN_SLOW}:\n${lines(judged.known)}`);
    if (judged.printed.length > 0) console.log(`\ntests that took longer than they may:\n${lines(judged.printed)}`);
    if (judged.stale.length > 0) console.log(`\non the slow list and within budget, prune with npx tsx tests/tiers/slow.ts --prune <key>:\n${lines(judged.stale)}`);
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
