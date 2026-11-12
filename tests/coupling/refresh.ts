import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { commitOf, gatheredIn, HASHED_PATHS, OUT, record, ROOT, runsOf, sourceOf } from './artifacts.js';
import { changedBetween, fileHashes, testsToRerun } from './impact.js';
import { runsIn } from './report.js';
import { workspaceOf, WORKSPACES, type Workspace } from './workspaces.js';

const TEST_FILE = /\.test\.(ts|tsx|mjs)$/;
const REPO_TESTS = /^tests\/(lib|coupling|alignment|tiers)\/[^/]+\.test\.ts$/;
const BACKEND = WORKSPACES.find((workspace) => workspace.name === 'backend')!;

const run = (command: string, args: string[], cwd = ROOT, env: NodeJS.ProcessEnv = process.env): boolean =>
  spawnSync(command, args, { cwd, env, stdio: 'inherit' }).status === 0;
const audit = (): void => { process.exitCode = run('npx', ['tsx', 'tests/coupling/audit.ts', '--require', 'in-process']) ? 0 : 1; };
const recordName = (testFile: string): string => testFile.replace(/[^A-Za-z0-9.-]+/g, '_');
const workspaceOfTest = (test: string): Workspace | undefined => (REPO_TESTS.test(test) ? BACKEND : workspaceOf(test));

const gathered = gatheredIn(OUT)['in-process'];
const now = fileHashes(ROOT, HASHED_PATHS);
const failed = gathered ? Object.entries(gathered.timings).filter(([, timing]) => !timing.passed).map(([name]) => name) : [];
if (!gathered?.complete || !gathered.files || failed.length > 0) {
  console.log(failed.length > 0 ? `the last gather failed in ${failed.join(', ')}, so everything is gathered` : 'no complete gather to start from, so everything is gathered');
  if (run('npx', ['tsx', 'tests/coupling/gather.ts'])) audit(); else process.exitCode = 1;
} else {
  const changed = changedBetween(gathered.files, now);
  const runsDir = runsOf(OUT, 'in-process');
  const tests = Object.keys(now).filter((file) => TEST_FILE.test(file) && workspaceOfTest(file) !== undefined);
  const plan = testsToRerun(runsIn(runsDir), changed, tests);
  if (plan.full) {
    console.log(`${plan.because} changed, which every test may read, so everything is gathered`);
    if (run('npx', ['tsx', 'tests/coupling/gather.ts'])) audit(); else process.exitCode = 1;
  } else {
    console.log(`${changed.size} files changed since the last gather; ${plan.tests.length} test files to run again`);
    const gone = new Set([...changed].filter((file) => !(file in now)).map(recordName));
    const again = new Set(plan.tests.map(recordName));
    for (const name of readdirSync(runsDir)) {
      const of = name.replace(/(\.child-\d+)?\.json$/, '');
      if (again.has(of) || gone.has(of)) rmSync(join(runsDir, name), { force: true });
    }
    let passed = true;
    for (const workspace of WORKSPACES) {
      const mine = plan.tests.filter((test) => workspaceOfTest(test) === workspace);
      if (mine.length === 0) continue;
      const cwd = join(ROOT, workspace.folder);
      const ok = run('npx', ['vitest', 'run', '--project', 'unit', '--project', 'integration', ...mine.map((test) => relative(cwd, join(ROOT, test)))], cwd, { ...process.env, COUPLING_COVERAGE: runsDir, TEMPORAL_DEBUG: '1' });
      passed &&= ok;
    }
    if (!passed) {
      console.log('a test failed, so the gather is left as it was and nothing is judged');
      process.exitCode = 1;
    } else {
      record(OUT, { ...gathered, source: sourceOf(), commit: commitOf(), at: new Date().toISOString(), files: now });
      audit();
    }
  }
}
