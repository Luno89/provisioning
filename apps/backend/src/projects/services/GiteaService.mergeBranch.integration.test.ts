import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GiteaService } from './GiteaService.js';
import { testDataDir } from '../../platform/testing/data-dir.js';

let root: string;
let remote: string;
let work: string;
let asked: string[];
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const inWork = (...args: string[]) => git('-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args);

function commit(branch: string, file: string, content: string): string {
  if (inWork('symbolic-ref', '--short', 'HEAD') !== branch) inWork('checkout', '-q', branch);
  writeFileSync(path.join(work, file), content);
  inWork('add', file);
  inWork('commit', '-q', '-m', `${file}: ${content}`);
  inWork('push', '-q', 'origin', branch);
  return inWork('rev-parse', 'HEAD');
}

function service(pulls: { listed?: unknown[][]; created?: Response } = {}): GiteaService {
  const gitea = new GiteaService('master-key' as never, { url: `file://${root}` }, { dataDir: testDataDir() });
  const internals = gitea as unknown as { getToken(): Promise<string> };
  vi.spyOn(internals, 'getToken').mockResolvedValue('bot-token');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const where = url.replace(`file://${root}`, '');
    asked.push(`${init.method ?? 'GET'} ${where}`);
    if (where.endsWith('/pulls?state=open&limit=50')) return Response.json(pulls.listed?.shift() ?? []);
    if (init.method === 'POST' && where.endsWith('/pulls')) return pulls.created ?? Response.json({ number: 1 });
    return Response.json({});
  }));
  return gitea;
}

beforeEach(() => {
  asked = [];
  root = mkdtempSync(path.join(tmpdir(), 'koala-gitea-landing-'));
  remote = path.join(root, 'koala-bo', 'shop.git');
  work = path.join(root, 'work');
  git('init', '-q', '--bare', '-b', 'main', remote);
  git('clone', '-q', remote, work);
  inWork('checkout', '-q', '-b', 'main');
  commit('main', 'README.md', 'start\n');
  inWork('checkout', '-q', '-b', 'leaf/l1');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('GiteaService.mergeBranch, landing with git', () => {
  it('opens the pull request, merges the story onto a main that moved on, and marks the pull request merged at that commit', async () => {
    const tip = commit('leaf/l1', 'pay.txt', 'pay\n');
    const moved = commit('main', 'ship.txt', 'ship\n');
    expect(await service().mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main', { title: 'Land Checkout', body: 'Goal: pay' })).toBe('merged');
    expect(asked).toEqual(['GET /api/v1/repos/koala-bo/shop/pulls?state=open&limit=50', 'POST /api/v1/repos/koala-bo/shop/pulls', 'PATCH /api/v1/repos/koala-bo/shop', 'POST /api/v1/repos/koala-bo/shop/pulls/1/merge']);
    expect(git('-C', remote, 'log', '-1', '--format=%P %s', 'main')).toBe(`${moved} ${tip} Land Checkout`);
  });

  it('answers a conflict and leaves main where it was', async () => {
    commit('leaf/l1', 'README.md', 'story\n');
    const before = commit('main', 'README.md', 'main\n');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await service().mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main')).toBe('conflict');
    expect(git('-C', remote, 'rev-parse', 'main')).toBe(before);
  });

  it('closes the pull request and changes nothing when main already holds the story', async () => {
    commit('leaf/l1', 'pay.txt', 'pay\n');
    expect(await service().mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main')).toBe('merged');
    const landed = git('-C', remote, 'rev-parse', 'main');
    asked = [];
    expect(await service().mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main')).toBe('nothing');
    expect(asked.at(-1)).toBe('PATCH /api/v1/repos/koala-bo/shop/pulls/1');
    expect(git('-C', remote, 'rev-parse', 'main')).toBe(landed);
  });

  it('lands through the pull request another landing opened between its look and its open', async () => {
    commit('leaf/l1', 'pay.txt', 'pay\n');
    const opened = [{ number: 4, head: { ref: 'leaf/l1' }, base: { ref: 'main' } }];
    expect(await service({ listed: [[], opened], created: Response.json({ message: 'pull request already exists for these targets' }, { status: 409 }) }).mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main')).toBe('merged');
    expect(asked.at(-1)).toBe('POST /api/v1/repos/koala-bo/shop/pulls/4/merge');
  });
});

