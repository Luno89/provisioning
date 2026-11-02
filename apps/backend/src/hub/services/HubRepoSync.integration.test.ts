import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mainHeads, syncMain } from './HubRepoSync.js';

const run = promisify(execFile);
const made: string[] = [];
afterEach(async () => { for (const dir of made.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

async function bare(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-sync-test-'));
  made.push(dir);
  await run('git', ['init', '--bare', '--quiet', '--initial-branch=main', dir]);
  return dir;
}

async function commit(repo: string, file: string, content: string): Promise<string> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-sync-work-'));
  made.push(work);
  const git = (...args: string[]) => run('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  await run('git', ['clone', '--quiet', repo, work]);
  const empty = !(await git('rev-parse', '--verify', '--quiet', 'HEAD').then(() => true, () => false));
  if (empty) await git('checkout', '--quiet', '-b', 'main');
  await fs.writeFile(path.join(work, file), content);
  await git('add', file);
  await git('commit', '--quiet', '-m', `${file}: ${content}`);
  await git('push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  return (await git('rev-parse', 'HEAD')).stdout.trim();
}

const read = async (repo: string, file: string, ref = 'main') => (await run('git', ['-C', repo, 'show', `${ref}:${file}`])).stdout;

describe('keeping the owner\'s main and the hub\'s main together', () => {
  it('fills an empty hub, then fast-forwards whichever side is behind', async () => {
    const owner = await bare();
    const hub = await bare();
    const first = await commit(owner, 'a.txt', 'one');
    expect(await syncMain({ url: owner }, { url: hub }, () => 'x')).toEqual({ outcome: 'to-hub', head: first });
    expect(await syncMain({ url: owner }, { url: hub }, () => 'x')).toEqual({ outcome: 'same', head: first });

    const fromMember = await commit(hub, 'b.txt', 'member');
    expect(await syncMain({ url: owner }, { url: hub }, () => 'x')).toEqual({ outcome: 'from-hub', head: fromMember });
    expect(await read(owner, 'b.txt')).toBe('member');
    expect(await mainHeads({ url: owner }, { url: hub })).toEqual({ owner: fromMember, hub: fromMember });
  });

  it('merges when both moved, and gives both sides the merge', async () => {
    const owner = await bare();
    const hub = await bare();
    await commit(owner, 'a.txt', 'one');
    await syncMain({ url: owner }, { url: hub }, () => 'x');
    await commit(owner, 'a.txt', 'two');
    await commit(hub, 'b.txt', 'member');
    const synced = await syncMain({ url: owner }, { url: hub }, () => 'x');
    expect(synced.outcome).toBe('merged');
    const heads = await mainHeads({ url: owner }, { url: hub });
    expect(heads.owner).toBe(heads.hub);
    expect([await read(owner, 'a.txt'), await read(owner, 'b.txt'), await read(hub, 'a.txt')]).toEqual(['two', 'member', 'two']);
  });

  it('changes neither main on a conflict, keeps the hub\'s beside the owner\'s, and names the files', async () => {
    const owner = await bare();
    const hub = await bare();
    await commit(owner, 'a.txt', 'one');
    await syncMain({ url: owner }, { url: hub }, () => 'x');
    const ownerHead = await commit(owner, 'a.txt', 'owner');
    const hubHead = await commit(hub, 'a.txt', 'member');
    expect(await syncMain({ url: owner }, { url: hub }, () => 'hub/main-1')).toEqual({ outcome: 'conflict', files: ['a.txt'], kept: 'hub/main-1' });
    expect(await mainHeads({ url: owner }, { url: hub })).toEqual({ owner: ownerHead, hub: hubHead });
    expect(await read(owner, 'a.txt', 'hub/main-1')).toBe('member');
  });
});

describe('when git cannot reach a repository', () => {
  it('says what git said when a main cannot be asked for', async () => {
    const owner = await bare();
    const missing = path.join(os.tmpdir(), 'hub-sync-test-nowhere', 'project.git');
    await expect(mainHeads({ url: owner }, { url: missing })).rejects.toThrow(/does not appear to be a git repository/);
  });

  it('fails a sync with the reason, leaves both repositories as they were, and never says the credential it was given', async () => {
    const owner = await bare();
    const first = await commit(owner, 'a.txt', 'one');
    const token = 'tkn-5f3a9c1e77d2';
    const missing = path.join(os.tmpdir(), `hub-sync-test-${token}`, 'project.git');
    const failure = await syncMain({ url: owner }, { url: missing, auth: { username: 'bot', token } }, () => 'x').catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    const said = (failure as Error).message;
    expect(said).toMatch(/^syncing main with the hub failed: /);
    expect(said).toMatch(/does not appear to be a git repository/);
    expect(said).toContain('***');
    expect(said).not.toContain(token);
    expect(await mainHeads({ url: owner }, { url: owner })).toEqual({ owner: first, hub: first });
  });
});
