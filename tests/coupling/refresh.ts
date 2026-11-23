import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectOfTest, type Setup } from '../tiers/projects.js';
import { commitOf, gatheredIn, HASHED_PATHS, OUT, record, ROOT, runsOf, sourceOf } from './artifacts.js';
import { changedBetween, changedLines, fileHashes, testsToRerun } from './impact.js';
import { runsIn } from './artifacts.js';
import { providedIn, setupsFor } from './setups.js';
import { workspaceOf, WORKSPACES, type Workspace } from './workspaces.js';

const TEST_FILE = /\.test\.(ts|tsx|mjs)$/;
const REPO_TESTS = /^tests\/(lib|coupling|alignment|tiers)\/[^/]+\.test\.ts$/;
const BACKEND = WORKSPACES.find((workspace) => workspace.name === 'backend')!;

const run = (command: string, args: string[], cwd = ROOT, env: NodeJS.ProcessEnv = process.env): boolean =>
  spawnSync(command, args, { cwd, env, stdio: 'inherit' }).status === 0;
const audit = (): void => { process.exitCode = run('npx', ['tsx', 'tests/coupling/audit.ts', '--require', 'in-process']) ? 0 : 1; };
const recordName = (testFile: string): string => testFile.replace(/[^A-Za-z0-9.-]+/g, '_');
const readIn = (file: string): string | undefined => { try { return readFileSync(join(ROOT, file), 'utf8'); } catch { return undefined; } };

async function providersOf(workspace: Workspace): Promise<Map<string, string>> {
  const table = join(ROOT, workspace.folder, 'vitest.setups.ts');
  const providers = new Map<string, string>();
  if (!existsSync(table)) return providers;
  const { OPTIONAL_SETUPS } = await import(pathToFileURL(table).href) as { OPTIONAL_SETUPS: Record<string, Setup> };
  for (const [name, setup] of Object.entries(OPTIONAL_SETUPS)) {
    for (const key of providedIn(readFileSync(join(ROOT, workspace.folder, setup.globalSetup), 'utf8'))) providers.set(key, name);
  }
  return providers;
}

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
  const runs = runsIn(runsDir);
  const plan = testsToRerun(runs, changedLines(ROOT, gathered.files, now, changed), tests);
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
      const integration = mine.filter((test) => projectOfTest(test) !== 'unit');
      const setups = setupsFor(integration, runs, changed, { read: readIn, exists: (file) => existsSync(join(ROOT, file)), providers: await providersOf(workspace) });
      const projects = [...new Set(mine.map(projectOfTest))];
      if (integration.length > 0) console.log(`${workspace.name}: ${mine.length} test files, starting ${setups.length > 0 ? setups.join(', ') : 'none'} of its optional setups`);
      const ok = run('npx', ['vitest', 'run', ...projects.flatMap((project) => ['--project', project]), ...mine.map((test) => relative(cwd, join(ROOT, test)))], cwd, { ...process.env, COUPLING_COVERAGE: runsDir, TEMPORAL_DEBUG: '1', KOALA_SETUPS: setups.join(',') });
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
