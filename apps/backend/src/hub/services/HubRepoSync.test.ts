import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { Processes } from '@koala/engine-core/processes';
import { mainHeads, syncMain } from './HubRepoSync.js';

type GitRun = Parameters<Processes['run']>[0];

const owner = { url: 'https://git.example/owner.git', auth: { username: 'koala', token: 'owner-secret' } };
const hub = { url: 'https://git.example/hub.git', auth: { username: 'bot', token: 'hub-secret' } };
const OWNER_HEAD = 'a'.repeat(40);
const HUB_HEAD = 'b'.repeat(40);

const said = (...words: string[]) => matches<GitRun>((run) => run.command === 'git' && run.args.join(' ').includes(words.join(' ')));
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const exited = (code: number, stderr = '') => ({ code, stdout: '', stderr });

type Scripted = [ReturnType<typeof said>, ReturnType<typeof ok>][];

function remotes(heads: { owner?: string; hub?: string }, scripted: Scripted = []) {
  const git = mock<Processes>();
  git.run.calledWith(matches<GitRun>(() => true)).mockResolvedValue(ok());
  git.run.calledWith(said('ls-remote', owner.url)).mockResolvedValue(ok(heads.owner ? `${heads.owner}\trefs/heads/main\n` : ''));
  git.run.calledWith(said('ls-remote', hub.url)).mockResolvedValue(ok(heads.hub ? `${heads.hub}\trefs/heads/main\n` : ''));
  for (const [asked, answer] of scripted) git.run.calledWith(asked).mockResolvedValue(answer);
  return git;
}

const pushes = (git: ReturnType<typeof remotes>): string[] =>
  git.run.mock.calls.map(([run]) => run.args.join(' ')).filter((line) => line.includes(' push ')).map((line) => line.slice(line.indexOf(' push ') + 1));

describe('reading the two mains', () => {
  it('names the head of main on each side, and nothing for a side that has none', async () => {
    const git = remotes({ owner: OWNER_HEAD });
    expect(await mainHeads(owner, hub, git)).toEqual({ owner: OWNER_HEAD, hub: undefined });
  });

  it('asks both remotes with each one\'s credential in the environment, never in the arguments', async () => {
    const git = remotes({ owner: OWNER_HEAD, hub: HUB_HEAD });
    await mainHeads(owner, hub, git);
    const asked = git.run.mock.calls.map(([run]) => run);
    expect(asked.map((run) => run.args)).toEqual([['ls-remote', owner.url, 'refs/heads/main'], ['ls-remote', hub.url, 'refs/heads/main']]);
    const basic = (end: typeof owner) => Buffer.from(`${end.auth.username}:${end.auth.token}`).toString('base64');
    for (const run of asked) {
      const env = Object.values(run.env ?? {}).join('\n');
      expect(env).toContain(basic(owner));
      expect(env).toContain(basic(hub));
      expect(run.args.join(' ')).not.toContain('secret');
    }
  });

  it('fails with what git said when a remote cannot be asked', async () => {
    const git = mock<Processes>();
    git.run.mockResolvedValue(exited(128, 'fatal: unable to access\n'));
    await expect(mainHeads(owner, hub, git)).rejects.toThrow('fatal: unable to access');
  });

  it('says the exit status when git failed without a word', async () => {
    const git = mock<Processes>();
    git.run.mockResolvedValue(exited(2));
    await expect(mainHeads(owner, hub, git)).rejects.toThrow('git exited 2');
  });
});

describe('keeping the owner\'s main and the hub\'s main together', () => {
  it('fills an empty hub from the owner', async () => {
    const git = remotes({ owner: OWNER_HEAD });
    expect(await syncMain(owner, hub, () => 'x', git)).toEqual({ outcome: 'to-hub', head: OWNER_HEAD });
    expect(pushes(git)).toEqual(['push --quiet hub refs/remotes/owner/main:refs/heads/main']);
  });

  it('fills an empty owner from the hub', async () => {
    const git = remotes({ hub: HUB_HEAD });
    expect(await syncMain(owner, hub, () => 'x', git)).toEqual({ outcome: 'from-hub', head: HUB_HEAD });
    expect(pushes(git)).toEqual(['push --quiet owner refs/remotes/hub/main:refs/heads/main']);
  });

  it('does nothing when both mains are the same commit', async () => {
    const git = remotes({ owner: OWNER_HEAD, hub: OWNER_HEAD });
    expect(await syncMain(owner, hub, () => 'x', git)).toEqual({ outcome: 'same', head: OWNER_HEAD });
    expect(pushes(git)).toEqual([]);
  });

  it('does nothing when neither side has a main', async () => {
    const git = remotes({});
    expect(await syncMain(owner, hub, () => 'x', git)).toEqual({ outcome: 'same', head: undefined });
    expect(pushes(git)).toEqual([]);
  });

  it('moves the hub forward when the owner is ahead of it', async () => {
    const git = remotes({ owner: OWNER_HEAD, hub: HUB_HEAD }, [
      [said('merge-base --is-ancestor', HUB_HEAD, OWNER_HEAD), ok()],
    ]);
    expect(await syncMain(owner, hub, () => 'x', git)).toEqual({ outcome: 'to-hub', head: OWNER_HEAD });
    expect(pushes(git)).toEqual(['push --quiet hub refs/remotes/owner/main:refs/heads/main']);
  });

  it('moves the owner forward when the hub is ahead of it', async () => {
    const git = remotes({ owner: OWNER_HEAD, hub: HUB_HEAD }, [
      [said('merge-base --is-ancestor', HUB_HEAD, OWNER_HEAD), exited(1)],
      [said('merge-base --is-ancestor', OWNER_HEAD, HUB_HEAD), ok()],
    ]);
    expect(await syncMain(owner, hub, () => 'x', git)).toEqual({ outcome: 'from-hub', head: HUB_HEAD });
    expect(pushes(git)).toEqual(['push --quiet owner refs/remotes/hub/main:refs/heads/main']);
  });

  it('merges when both moved and gives both sides the merge', async () => {
    const git = remotes({ owner: OWNER_HEAD, hub: HUB_HEAD }, [
      [said('merge-base --is-ancestor'), exited(1)],
      [said('rev-parse HEAD'), ok('c'.repeat(40) + '\n')],
    ]);
    expect(await syncMain(owner, hub, () => 'x', git)).toEqual({ outcome: 'merged', head: 'c'.repeat(40) });
    expect(pushes(git)).toEqual(['push --quiet hub HEAD:refs/heads/main', 'push --quiet owner HEAD:refs/heads/main']);
  });

  it('changes neither main on a conflict, keeps the hub\'s beside the owner\'s, and names the files', async () => {
    const git = remotes({ owner: OWNER_HEAD, hub: HUB_HEAD }, [
      [said('merge-base --is-ancestor'), exited(1)],
      [said('merge --quiet --no-edit'), exited(1)],
      [said('diff --name-only --diff-filter=U'), ok('a.txt\n\n b.txt \n')],
    ]);
    expect(await syncMain(owner, hub, () => 'hub/main-1', git)).toEqual({ outcome: 'conflict', files: ['a.txt', 'b.txt'], kept: 'hub/main-1' });
    expect(pushes(git)).toEqual(['push --quiet owner refs/remotes/hub/main:refs/heads/hub/main-1']);
    expect(git.run.mock.calls.map(([run]) => run.args.join(' ')).some((line) => line.endsWith('merge --abort'))).toBe(true);
  });

  it('fails with git\'s words and without either credential when a step is refused', async () => {
    const git = remotes({ owner: OWNER_HEAD }, [
      [said('push --quiet hub'), exited(128, `remote: denied for ${hub.auth.token} and ${owner.auth.token}\n`)],
    ]);
    const failure = await syncMain(owner, hub, () => 'x', git).catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('syncing main with the hub failed: remote: denied for *** and ***');
  });

  it('fails when git cannot tell whether one main contains the other', async () => {
    const git = remotes({ owner: OWNER_HEAD, hub: HUB_HEAD }, [
      [said('merge-base --is-ancestor'), exited(128, 'fatal: bad object')],
    ]);
    await expect(syncMain(owner, hub, () => 'x', git)).rejects.toThrow('syncing main with the hub failed: fatal: bad object');
  });

  it('fails when a merge fails for a reason other than a conflict', async () => {
    const git = remotes({ owner: OWNER_HEAD, hub: HUB_HEAD }, [
      [said('merge-base --is-ancestor'), exited(1)],
      [said('merge --quiet --no-edit'), exited(128, 'fatal: out of memory')],
    ]);
    await expect(syncMain(owner, hub, () => 'x', git)).rejects.toThrow('fatal: out of memory');
  });

  it('fails when the scratch repository cannot be made', async () => {
    const git = mock<Processes>();
    git.run.mockResolvedValue(exited(1, 'no git here'));
    await expect(syncMain(owner, hub, () => 'x', git)).rejects.toThrow('no git here');
  });
});
