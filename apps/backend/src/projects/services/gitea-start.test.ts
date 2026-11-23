import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { reopening } from '@koala/engine-core/reopening';
import type { GiteaService } from './GiteaService.js';
import { MemoryInfrastructureStore } from '../../infrastructure/testing/memory-store.js';
import { openedRecord, SetUpPieces } from '../../infrastructure/index.js';
import { keepUsersPrivate, usersPrivateOnceGiteaIsUp } from './gitea-start.js';

function refusals() {
  const refused: string[] = [];
  return { refused, told: { refused: (dependency: string, reason: string) => { refused.push(`${dependency}: ${reason}`); } } };
}

describe('the pass that makes Gitea\'s users private at start', () => {
  it('users left public at start are made private once Gitea answers', async () => {
    const gitea = mock<GiteaService>();
    gitea.makeUsersPrivate.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).mockResolvedValue(['koala-u1']);
    const said: string[] = [];
    const { refused, told } = refusals();

    expect(await keepUsersPrivate(gitea, told, { again: () => reopening(5), log: (message) => said.push(message) })).toBe(false);

    await vi.waitFor(() => expect(gitea.makeUsersPrivate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(said.at(-1)).toBe('[gitea] made 1 user(s) private: koala-u1'));
    expect(said[0]).toMatch(/^\[gitea\] not every Gitea user is private yet: it refused the connection \(ECONNREFUSED\); trying again in/);
    expect(refused).toEqual([]);
  });

  it('holds Gitea as refused, and stops asking, once it refuses for good', async () => {
    const gitea = mock<GiteaService>();
    gitea.makeUsersPrivate.mockRejectedValue(Object.assign(new Error('Gitea would not list its users (HTTP 401)'), { status: 401 }));
    const { refused, told } = refusals();

    expect(await keepUsersPrivate(gitea, told, { again: () => reopening(5), log: () => undefined })).toBe(false);

    expect(refused).toEqual(['gitea: making every Gitea user private: it refused the request (401)']);
    expect(gitea.makeUsersPrivate).toHaveBeenCalledTimes(1);
  });
});

describe('making Gitea\'s users private waits for Gitea\'s setup piece', () => {
  it('asks nothing of Gitea before its piece is up, and a missing admin password is final once it is', async () => {
    const store = new MemoryInfrastructureStore();
    const record = openedRecord({ ownerId: 'owner-1', target: { kind: 'koala', clusterId: 'machine-desk' }, revision: 4, reason: 'revision', runId: 'provision-machine-desk~a', at: '2026-11-23T12:04:00.000Z' });
    await store.openProvisioning(record);
    const lines: string[] = [];
    const pieces = new SetUpPieces({ store, clusterId: 'machine-desk' }, (line) => lines.push(line));
    await pieces.follow();
    const gitea = mock<GiteaService>();
    const missing = "ENOENT: no such file or directory, open '/srv/koala/.gitea-admin-password'";
    gitea.makeUsersPrivate.mockRejectedValue(Object.assign(new Error(missing), { code: 'ENOENT', syscall: 'open' }));
    const { refused, told } = refusals();

    usersPrivateOnceGiteaIsUp(gitea, told, pieces, { again: () => reopening(5), log: () => undefined });

    expect(gitea.makeUsersPrivate).not.toHaveBeenCalled();
    expect(refused).toEqual([]);
    expect(lines).toEqual(['[setup] making every Gitea user private waits for Gitea, your repositories and images to be set up']);

    await store.patchProvisioning(record.id, { pieces: record.pieces.map((piece) => (piece.key === 'gitea' ? { ...piece, state: 'up' as const } : piece)) });

    await vi.waitFor(() => expect(refused).toEqual([`gitea: making every Gitea user private: ${missing}`]));
    expect(gitea.makeUsersPrivate).toHaveBeenCalledTimes(1);
    await pieces.close();
  });
});
