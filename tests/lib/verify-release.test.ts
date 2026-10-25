import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = new URL('../../scripts/root-node/verify-release.sh', import.meta.url).pathname;
const dirs: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const run = (cwd: string, command: string, ...args: string[]) => execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();

function signingKey(): { key: string; signer: string } {
  const key = join(scratch('release-key-'), 'key');
  run(tmpdir(), 'ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'throwaway release key', '-f', key);
  return { key, signer: `koala-release namespaces="git" ${readFileSync(`${key}.pub`, 'utf8').trim()}` };
}

function repo(): { dir: string; commit: string } {
  const dir = scratch('release-repo-');
  run(dir, 'git', 'init', '-q');
  writeFileSync(join(dir, 'README'), 'x');
  run(dir, 'git', 'add', '-A');
  run(dir, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'a commit');
  return { dir, commit: run(dir, 'git', 'rev-parse', 'HEAD') };
}

const tag = (dir: string, name: string, key?: string) => run(dir, 'git', '-c', 'user.email=t@t', '-c', 'user.name=t',
  ...(key ? ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`] : []), 'tag', ...(key ? ['-s'] : ['-a']), name, '-m', name);

function verify(dir: string, name: string, signers: string) {
  const file = join(scratch('release-signers-'), 'signers');
  writeFileSync(file, `${signers}\n`);
  return spawnSync('bash', [SCRIPT, 'tag', dir, name], { encoding: 'utf8', env: { ...process.env, RELEASE_SIGNERS: file } });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a release tag root will move onto', () => {
  it('is signed by a key root trusts, and names its commit', () => {
    const { key, signer } = signingKey();
    const { dir, commit } = repo();
    tag(dir, 'v2026.10.25', key);
    const verified = verify(dir, 'v2026.10.25', signer);
    expect(verified.status).toBe(0);
    expect(verified.stdout.trim()).toBe(commit);
  });

  it('is refused unsigned', () => {
    const { signer } = signingKey();
    const { dir } = repo();
    tag(dir, 'v2026.10.25');
    const verified = verify(dir, 'v2026.10.25', signer);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('v2026.10.25 is not signed by a key in');
  });

  it('is refused when signed by a key root does not trust', () => {
    const { key } = signingKey();
    const { signer: trusted } = signingKey();
    const { dir } = repo();
    tag(dir, 'v2026.10.25', key);
    const verified = verify(dir, 'v2026.10.25', trusted);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('v2026.10.25 is not signed by a key in');
  });

  it('is refused when it is a branch or a lightweight tag', () => {
    const { signer } = signingKey();
    const { dir } = repo();
    run(dir, 'git', 'tag', 'v2026.10.25');
    const verified = verify(dir, 'v2026.10.25', signer);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toContain('v2026.10.25 is not an annotated tag');
  });
});
