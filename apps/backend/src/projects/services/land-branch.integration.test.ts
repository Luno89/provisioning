import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unpromptedGit } from '../../platform/lib/git-env.js';
import type { Processes } from '@koala/engine-core/processes';
import { nodeProcesses } from '@koala/engine-core/node-processes';
import { landBranch, type LandRequest } from './land-branch.js';

let root: string;
let remote: string;
let work: string;
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

const story = (from = 'main') => { inWork('checkout', '-q', '-b', 'leaf/l1', from); inWork('push', '-q', 'origin', 'leaf/l1'); };
const request = (): LandRequest => ({ bare: path.join(root, `landing-${Math.random().toString(36).slice(2, 8)}.git`), url: `file://${remote}`, base: 'main', head: 'leaf/l1', message: 'Land Checkout\n\nGoal: pay', env: unpromptedGit(process.env) });
const mainOf = () => git('-C', remote, 'rev-parse', 'main');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'koala-landing-'));
  remote = path.join(root, 'shop.git');
  work = path.join(root, 'work');
  git('init', '-q', '--bare', '-b', 'main', remote);
  git('clone', '-q', remote, work);
  inWork('checkout', '-q', '-b', 'main');
  commit('main', 'README.md', 'start\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('landing a story\'s branch on main with git', () => {
  it('moves main forward to the branch when main has not moved since it was made', async () => {
    story();
    const tip = commit('leaf/l1', 'pay.txt', 'pay\n');
    expect(await landBranch(request())).toEqual({ outcome: 'merged', commit: tip, already: false });
    expect(mainOf()).toBe(tip);
  });

  it('makes a merge commit as Koala, with the title and goal, when main moved on', async () => {
    story();
    const tip = commit('leaf/l1', 'pay.txt', 'pay\n');
    const moved = commit('main', 'ship.txt', 'ship\n');
    const landed = await landBranch(request());
    expect(landed).toMatchObject({ outcome: 'merged', already: false });
    expect(mainOf()).toBe(landed.outcome === 'merged' ? landed.commit : '');
    expect(git('-C', remote, 'log', '-1', '--format=%P|%an <%ae>|%B', 'main').trim()).toBe(`${moved} ${tip}|Koala <koala@localhost>|Land Checkout\n\nGoal: pay`);
    expect(git('-C', remote, 'show', 'main:pay.txt')).toBe('pay');
    expect(git('-C', remote, 'show', 'main:ship.txt')).toBe('ship');
  });

  it('changes nothing when the branch is already on main, so landing again after a crash is harmless', async () => {
    story();
    commit('leaf/l1', 'pay.txt', 'pay\n');
    const first = await landBranch(request());
    expect(await landBranch(request())).toEqual({ outcome: 'merged', commit: first.outcome === 'merged' ? first.commit : '', already: true });
  });

  it('names the files that conflict and leaves main as it was', async () => {
    story();
    commit('leaf/l1', 'README.md', 'leaf\n');
    const before = commit('main', 'README.md', 'main\n');
    expect(await landBranch(request())).toEqual({ outcome: 'conflict', files: ['README.md'] });
    expect(mainOf()).toBe(before);
  });

  it('merges again onto main when it moved between the fetch and the push, never forcing over what landed meanwhile', async () => {
    story();
    commit('leaf/l1', 'pay.txt', 'pay\n');
    let meanwhile = '';
    const racing: Processes = {
      run: async (run) => {
        if (run.args.includes('push') && !meanwhile) meanwhile = commit('main', 'other.txt', 'landed meanwhile\n');
        return nodeProcesses.run(run);
      },
    };
    const landed = await landBranch(request(), racing);
    expect(landed).toMatchObject({ outcome: 'merged', already: false });
    expect(git('-C', remote, 'merge-base', '--is-ancestor', meanwhile, 'main')).toBe('');
    expect(git('-C', remote, 'show', 'main:other.txt')).toBe('landed meanwhile');
    expect(git('-C', remote, 'show', 'main:pay.txt')).toBe('pay');
  });
});

describe('landing when git cannot', () => {
  it('fails with git\'s own words when the repository cannot be reached', async () => {
    await expect(landBranch({ ...request(), url: `file://${root}/nowhere.git` })).rejects.toThrow(/does not appear to be a git repository|not found|No such/i);
  });
});
