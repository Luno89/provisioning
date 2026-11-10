import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codeCommitOf, ignoredIn, leaksIn, pushedGates, writeRecord } from './gate-runs.js';
import { checkedThrough } from './gates.js';

const repos: string[] = [];
const run = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

function repoWith(files: Record<string, string>, gitignore: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'ignored-in-'));
  repos.push(repo);
  run(repo, 'init', '-q');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  run(repo, 'add', '-A');
  writeFileSync(join(repo, '.gitignore'), gitignore);
  run(repo, 'add', '.gitignore');
  run(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'files committed before .gitignore listed them');
  return repo;
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe('what a commit carries that .gitignore lists', () => {
  it('finds files committed before .gitignore listed them, and leaves out the ones it makes an exception for', () => {
    const repo = repoWith({
      'apps/backend/data/.infisical-encryption-key': 'k',
      'apps/backend/.env.example': 'PORT=3001',
      'packages/infra/.gen/providers/helm/index.ts': 'x',
      'src/index.ts': 'x',
    }, '.env.*\n!.env.example\n/apps/backend/data/.infisical-*\n.gen/\n!packages/infra/.gen/\n');
    expect(ignoredIn(repo, 'HEAD')).toEqual(['apps/backend/data/.infisical-encryption-key']);
  });

  it('finds nothing in a commit that carries nothing ignored', () => {
    const repo = repoWith({ 'src/index.ts': 'x' }, 'node_modules/\n');
    expect(ignoredIn(repo, 'HEAD')).toEqual([]);
  });
});

describe('what Gitleaks finds in the commits a push adds', () => {
  const token = () => `ghp_${randomBytes(27).toString('base64url').replace(/[-_]/g, 'x').slice(0, 36)}`;

  it('finds a token committed since what the remote has, never printing it, and nothing in the commits before', () => {
    const value = token();
    const repo = repoWith({ 'src/index.ts': 'x' }, '');
    const before = run(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src/config.ts'), `export const githubToken = '${value}';\n`);
    run(repo, 'add', '-A');
    run(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'a token');
    const found = leaksIn(repo, `${before}..HEAD`);
    expect(found).toMatch(/src\/config\.ts/);
    expect(found).not.toContain(value);
    expect(leaksIn(repo, `${before}~0..${before}`)).toBeUndefined();
  });
});

describe('which commit a step\'s pass belongs to', () => {
  const commit = (repo: string, file: string, content: string, message: string): string => {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), content);
    run(repo, 'add', '-A');
    run(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message);
    return run(repo, 'rev-parse', 'HEAD');
  };

  it('is the last commit that changed code, through any number of ledger-only commits on top, and never across a code change', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gate-passes-'));
    repos.push(repo);
    run(repo, 'init', '-q');
    const code = commit(repo, 'src/a.ts', 'one', 'code');
    writeRecord(repo, { commit: code, checked: [{ name: 'lint', script: 'lint', minutes: 1 }] });
    commit(repo, 'tests/last-passed.json', '{"a":1}', 'ledger');
    const top = commit(repo, 'tests/test-failures.json', '{}', 'ledger again');
    expect(codeCommitOf(repo, top)).toBe(code);
    expect(checkedThrough(pushedGates(repo, top)).map((step) => step.script)).toEqual(['lint']);
    const changed = commit(repo, 'src/a.ts', 'two', 'more code');
    expect(codeCommitOf(repo, changed)).toBe(changed);
    expect(checkedThrough(pushedGates(repo, changed))).toEqual([]);
  });
});
