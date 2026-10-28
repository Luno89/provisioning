import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GiteaConflictError, GiteaService } from './GiteaService.js';

const root = mkdtempSync(path.join(tmpdir(), 'gitea-drop-'));
const remote = path.join(root, 'koala-u1', 'shop.git');
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const png = Buffer.from(Array.from({ length: 300_000 }, (_, index) => (index * 7) % 256));

function source(name: string, bytes: Buffer): string {
  const file = path.join(root, 'sources', name);
  writeFileSync(file, bytes);
  return file;
}

function service(): GiteaService {
  const gitea = new GiteaService({} as never, 'master-key', '/tmp/kubeconfig');
  vi.spyOn(gitea as any, 'resolveBaseUrl').mockResolvedValue(`file://${root}`);
  vi.spyOn(gitea as any, 'getToken').mockResolvedValue('admin');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ full_name: 'Ada', email: 'ada@example.com' }), { status: 200 })));
  return gitea;
}

const auth = { username: 'koala-u1', token: 'tok' };

beforeAll(() => {
  execFileSync('mkdir', ['-p', path.join(root, 'sources'), path.join(root, 'seed', 'docs')]);
  const seed = path.join(root, 'seed');
  git('init', '-q', '-b', 'main', seed);
  writeFileSync(path.join(seed, 'README.md'), 'hi\n');
  writeFileSync(path.join(seed, 'docs', 'a.md'), 'a\n');
  git('-C', seed, 'add', '-A');
  git('-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'start');
  git('clone', '-q', '--bare', seed, remote);
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('GiteaService.commitDropFromDisk', () => {
  it('commits every file of a drop at once from disk onto the default branch, as the person, bytes intact', async () => {
    const { commit } = await service().commitDropFromDisk(auth, 'koala-u1', 'shop', [
      { path: 'README.md', source: source('0', Buffer.from('changed\n')) },
      { path: 'public/logo.png', source: source('1', png) },
    ], 'Add files');
    expect(git('-C', remote, 'rev-parse', 'main')).toBe(commit);
    expect(git('-C', remote, 'log', '-1', '--format=%an <%ae> %s', 'main')).toBe('Ada <ada@example.com> Add files');
    expect(execFileSync('git', ['-C', remote, 'cat-file', 'blob', 'main:public/logo.png'])).toEqual(png);
    expect(git('-C', remote, 'show', 'main:README.md')).toBe('changed');
    expect(git('-C', remote, 'show', 'main:docs/a.md')).toBe('a');
  });

  it('starts a new branch from the one named, for a drop that goes to a story, leaving that one as it was', async () => {
    const before = git('-C', remote, 'rev-parse', 'main');
    const { commit } = await service().commitDropFromDisk(auth, 'koala-u1', 'shop', [{ path: 'a.txt', source: source('2', Buffer.from('a')) }], 'm', 'main', 'drop/l1/s1');
    expect(git('-C', remote, 'rev-parse', 'drop/l1/s1')).toBe(commit);
    expect(git('-C', remote, 'rev-parse', `${commit}^`)).toBe(before);
    expect(git('-C', remote, 'rev-parse', 'main')).toBe(before);
  });

  it('refuses a file where the repository has a folder, or under a file, and a branch already taken, changing nothing', async () => {
    const before = git('-C', remote, 'rev-parse', 'main');
    await expect(service().commitDropFromDisk(auth, 'koala-u1', 'shop', [{ path: 'docs', source: source('3', Buffer.from('x')) }], 'm')).rejects.toThrow(GiteaConflictError);
    await expect(service().commitDropFromDisk(auth, 'koala-u1', 'shop', [{ path: 'README.md/x', source: source('4', Buffer.from('x')) }], 'm')).rejects.toThrow('"README.md" is a file');
    await expect(service().commitDropFromDisk(auth, 'koala-u1', 'shop', [{ path: 'b.txt', source: source('5', Buffer.from('b')) }], 'm', 'main', 'drop/l1/s1')).rejects.toThrow('changed while it was being committed');
    expect(git('-C', remote, 'rev-parse', 'main')).toBe(before);
  });
});
