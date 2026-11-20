import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookAnswer, startRefactor } from './tdd-gate-hook.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const SCRATCH = join(REPO, 'node_modules', '.cache');

const worlds: string[] = [];
afterEach(() => { for (const dir of worlds.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function aRepo(): { dir: string; git: (...args: string[]) => string; write: (path: string, text: string) => void } {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH, 'tdd-gate-'));
  worlds.push(dir);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  const write = (path: string, text: string) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
  git('init', '-q');
  git('config', 'user.email', 'gate@test');
  git('config', 'user.name', 'gate');
  write('scripts/sum.ts', 'export const sum = (a: number, b: number) => a + b;\n');
  write('scripts/sum.test.ts', "import { expect, it } from 'vitest';\nimport { sum } from './sum.js';\nit('adds', () => { expect(sum(1, 2)).toBe(3); });\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  return { dir, git, write };
}

const edit = (dir: string, path: string) => hookAnswer({ tool_name: 'Edit', tool_input: { file_path: join(dir, path) }, cwd: dir });
const commit = (dir: string) => hookAnswer({ tool_name: 'Bash', tool_input: { command: 'git commit -m change' }, cwd: dir });
const denied = (answer: ReturnType<typeof hookAnswer>) => answer?.hookSpecificOutput.permissionDecision === 'deny' ? answer.hookSpecificOutput.permissionDecisionReason : undefined;

describe('the red-green gate on a real repository', () => {
  it('refuses a source edit until a new test fails, then refuses the commit until it passes', () => {
    const { dir, git, write } = aRepo();
    expect(denied(edit(dir, 'scripts/sum.ts'))).toMatch(/write the failing test first/);

    write('scripts/sum.test.ts', "import { expect, it } from 'vitest';\nimport { sum } from './sum.js';\nit('adds', () => { expect(sum(1, 2)).toBe(3); });\nit('adds three', () => { expect(sum(1, 2, 3)).toBe(6); });\n");
    expect(edit(dir, 'scripts/sum.ts')).toBeUndefined();

    write('scripts/sum.ts', 'export const sum = (a: number, b: number) => a + b;\n// unfinished\n');
    git('add', '-A');
    expect(denied(commit(dir))).toMatch(/do not pass yet/);

    write('scripts/sum.ts', 'export const sum = (...all: number[]) => all.reduce((total, n) => total + n, 0);\n');
    git('add', '-A');
    expect(commit(dir)).toBeUndefined();
  });

  it('lets a removal through that trims a test still passing, with no red, yet holds one that adds a new test file to red first', () => {
    const { dir, git, write } = aRepo();
    write('scripts/sum.ts', 'export const sum = (a: number, b: number) => a + b;\nexport const twice = (a: number) => a * 2;\nexport const thrice = (a: number) => a * 3;\n');
    write('scripts/sum.test.ts', "import { expect, it } from 'vitest';\nimport { sum, thrice, twice } from './sum.js';\nit('adds', () => { expect(sum(1, 2)).toBe(3); });\nit('doubles', () => { expect(twice(2)).toBe(4); });\nit('triples', () => { expect(thrice(2)).toBe(6); });\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'more');

    write('scripts/sum.ts', 'export const sum = (a: number, b: number): number => a + b;\n');
    write('scripts/sum.test.ts', "import { expect, it } from 'vitest';\nimport { sum } from './sum.js';\nit('adds', () => { expect(sum(1, 2)).toBe(3); });\n");
    write('scripts/other.test.ts', "import { expect, it } from 'vitest';\nit('is new', () => { expect(1).toBe(1); });\n");
    git('add', '-A');
    expect(denied(commit(dir))).toMatch(/never seen failing/);

    git('rm', '-q', '--cached', 'scripts/other.test.ts');
    rmSync(join(dir, 'scripts/other.test.ts'));
    expect(commit(dir)).toBeUndefined();
  });

  it('takes a test moved with the code it tests as moved, not new, so a removal that moves it needs no red', () => {
    const { dir, git, write } = aRepo();
    write('scripts/sum.ts', 'export const sum = (a: number, b: number) => a + b;\nexport const twice = (a: number) => a * 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'more');

    write('scripts/sum.ts', 'export const sum = (a: number, b: number): number => a + b;\n');
    mkdirSync(join(dir, 'scripts/math'), { recursive: true });
    git('mv', 'scripts/sum.test.ts', 'scripts/math/sum.test.ts');
    write('scripts/math/sum.test.ts', "import { expect, it } from 'vitest';\nimport { sum } from '../sum.js';\nit('adds', () => { expect(sum(1, 2)).toBe(3); });\n");
    git('add', '-A');
    expect(commit(dir)).toBeUndefined();
  });

  it('holds a source file moved to a new place to red-green like any other source change', () => {
    const { dir, git, write } = aRepo();
    const many = Array.from({ length: 12 }, (_, at) => `export const plus${at} = (a: number) => a + ${at};\n`).join('');
    write('scripts/many.ts', many);
    git('add', '-A');
    git('commit', '-q', '-m', 'many');
    mkdirSync(join(dir, 'scripts/math'), { recursive: true });
    git('mv', 'scripts/many.ts', 'scripts/math/many.ts');
    write('scripts/math/many.ts', `${many}export const unproven = (a: number) => a - 1;\n`);
    git('add', '-A');
    expect(git('diff', '--cached', '--name-status')).toMatch(/^R/m);
    expect(denied(commit(dir))).toMatch(/no test/);
  });

  it('refuses a new test that already passes, since it shows nothing missing', () => {
    const { dir, write } = aRepo();
    write('scripts/sum.test.ts', "import { expect, it } from 'vitest';\nimport { sum } from './sum.js';\nit('adds', () => { expect(sum(1, 2)).toBe(3); });\nit('adds again', () => { expect(sum(2, 2)).toBe(4); });\n");
    expect(denied(edit(dir, 'scripts/sum.ts'))).toMatch(/make it fail first/);
  });

  it('lets a refactor commit through when the file\'s own tests stay green, and a plan edit through at any time', () => {
    const { dir, git, write } = aRepo();
    expect(hookAnswer({ tool_name: 'Edit', tool_input: { file_path: join(dir, 'CLAUDE.md') }, cwd: dir })).toBeUndefined();
    write('scripts/sum.ts', 'export const sum = (a: number, b: number): number => b + a;\n');
    git('add', '-A');
    expect(commit(dir)).toBeUndefined();
  });

  it('lets a declared refactor edit source with no new test, once the touched code\'s tests are green, and refuses it while they are red', () => {
    const { dir, git, write } = aRepo();
    expect(startRefactor(dir, ['scripts/sum.ts'])).toEqual({ ok: true });
    expect(edit(dir, 'scripts/sum.ts')).toBeUndefined();
    write('scripts/sum.ts', 'export const sum = (a: number, b: number): number => b + a;\n');
    git('add', '-A');
    expect(commit(dir)).toBeUndefined();

    write('scripts/sum.test.ts', "import { expect, it } from 'vitest';\nimport { sum } from './sum.js';\nit('adds', () => { expect(sum(1, 2)).toBe(4); });\n");
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'a red test, for the case');
    const refused = startRefactor(dir, ['scripts/sum.ts']);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.why).toMatch(/green first/);
  });

  it('judges the checkout a command moves into before it commits, not the one the session started in', () => {
    const { dir, write, git } = aRepo();
    write('scripts/other.ts', 'export const other = 1;\n');
    git('add', '-A');
    const elsewhere = REPO;
    expect(denied(hookAnswer({ tool_name: 'Bash', tool_input: { command: `cd ${dir} && git commit -m change` }, cwd: elsewhere }))).toMatch(/no test/);
    expect(denied(hookAnswer({ tool_name: 'Bash', tool_input: { command: `git -C ${dir} commit -m change` }, cwd: elsewhere }))).toMatch(/no test/);
  });

  it('lets a merge commit through, since each side was held to red-green where it was made', () => {
    const { dir, git, write } = aRepo();
    git('checkout', '-q', '-b', 'side');
    write('scripts/other.ts', 'export const other = 1;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'side work');
    git('checkout', '-q', '-');
    write('scripts/third.ts', 'export const third = 1;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'main work');
    git('merge', '--no-commit', '--no-ff', 'side');
    expect(commit(dir)).toBeUndefined();
  });

  it('refuses a commit whose source changed through the shell with no test seen failing', () => {
    const { dir, git, write } = aRepo();
    write('scripts/other.ts', 'export const other = 1;\n');
    git('add', '-A');
    expect(denied(commit(dir))).toMatch(/no test/);
  });
});
