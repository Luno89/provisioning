import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ignoredIn } from './gate-runs.js';

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
