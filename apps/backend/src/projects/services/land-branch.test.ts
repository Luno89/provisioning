import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ProcessResult, ProcessRun, Processes } from '../../platform/lib/processes.js';
import { landBranch, type LandRequest } from './land-branch.js';

const BASE = 'b'.repeat(40);
const HEAD = 'h'.repeat(40);
const ok = (stdout = ''): ProcessResult => ({ code: 0, stdout, stderr: '' });
const no = (code = 1, stderr = ''): ProcessResult => ({ code, stdout: '', stderr });
const request: LandRequest = { bare: '/scratch/repo.git', url: 'https://git.example/koala/shop.git', base: 'main', head: 'leaf/l1', message: 'Land Checkout', env: {} };

type Answers = Partial<Record<'contains-head' | 'contains-base' | 'merge-tree' | 'commit-tree' | 'push', ProcessResult[]>>;

function git(answers: Answers) {
  const runs: string[][] = [];
  const next = (key: keyof Answers) => answers[key]?.shift() ?? ok();
  const processes = mock<Processes>();
  processes.run.mockImplementation(async ({ args }: ProcessRun) => {
    const own = args.slice(2);
    runs.push([...own]);
    if (own[0] === 'rev-parse') return ok(own[1] === 'refs/koala/base' ? BASE : HEAD);
    if (own[0] === 'merge-base') return next(own[2] === HEAD ? 'contains-head' : 'contains-base');
    if (own[0] === 'merge-tree') return next('merge-tree');
    if (own[0] === 'commit-tree') return next('commit-tree');
    if (own[0] === 'push') return next('push');
    return ok();
  });
  return { processes, runs };
}

describe('landing a story\'s branch, from git\'s answers', () => {
  it('pushes the branch itself when main is behind it', async () => {
    const { processes, runs } = git({ 'contains-head': [no()], 'contains-base': [ok()] });
    expect(await landBranch(request, processes)).toEqual({ outcome: 'merged', commit: HEAD, already: false });
    expect(runs.find((args) => args[0] === 'push')).toEqual(['push', '--quiet', request.url, `${HEAD}:refs/heads/main`]);
  });

  it('commits the merged tree onto both and pushes that, never forcing', async () => {
    const { processes, runs } = git({ 'contains-head': [no()], 'contains-base': [no()], 'merge-tree': [ok('t'.repeat(40))], 'commit-tree': [ok('m'.repeat(40))] });
    expect(await landBranch(request, processes)).toEqual({ outcome: 'merged', commit: 'm'.repeat(40), already: false });
    expect(runs.find((args) => args[0] === 'commit-tree')).toEqual(['commit-tree', 't'.repeat(40), '-p', BASE, '-p', HEAD, '-m', 'Land Checkout']);
    expect(runs.some((args) => args.includes('--force') || args.some((arg) => arg.startsWith('+') && arg.includes(':refs/heads/')))).toBe(false);
  });

  it('says it was already landed, pushing nothing', async () => {
    const { processes, runs } = git({ 'contains-head': [ok()] });
    expect(await landBranch(request, processes)).toEqual({ outcome: 'merged', commit: BASE, already: true });
    expect(runs.some((args) => args[0] === 'push')).toBe(false);
  });

  it('names the files that conflict, pushing nothing', async () => {
    const { processes, runs } = git({ 'contains-head': [no()], 'contains-base': [no()], 'merge-tree': [{ code: 1, stdout: `${'t'.repeat(40)}\nREADME.md\nsrc/pay.ts\n`, stderr: '' }] });
    expect(await landBranch(request, processes)).toEqual({ outcome: 'conflict', files: ['README.md', 'src/pay.ts'] });
    expect(runs.some((args) => args[0] === 'push')).toBe(false);
  });

  it('fetches and lands again when the push is refused because main moved on', async () => {
    const { processes, runs } = git({ 'contains-head': [no(), no()], 'contains-base': [ok(), ok()], push: [no(1, ' ! [rejected]        main -> main (fetch first)'), ok()] });
    expect(await landBranch(request, processes)).toMatchObject({ outcome: 'merged' });
    expect(runs.filter((args) => args[0] === 'fetch')).toHaveLength(2);
  });

  it('fails with git\'s words when the push is refused for any other reason, or merging cannot be asked', async () => {
    await expect(landBranch(request, git({ 'contains-head': [no()], 'contains-base': [ok()], push: [no(128, 'fatal: Authentication failed')] }).processes)).rejects.toThrow('Authentication failed');
    await expect(landBranch(request, git({ 'contains-head': [no(128, 'fatal: bad object')] }).processes)).rejects.toThrow('bad object');
    await expect(landBranch(request, git({ 'contains-head': [no()], 'contains-base': [no()], 'merge-tree': [no(129, 'usage: git merge-tree')] }).processes)).rejects.toThrow('usage');
  });
});
