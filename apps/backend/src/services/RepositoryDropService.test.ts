import { describe, expect, it, vi } from 'vitest';
import { RepositoryDropService } from './RepositoryDropService.js';

const files = [{ path: 'src/a.ts', bytes: Buffer.from('a') }, { path: 'logo.png', bytes: Buffer.from([0, 255]) }];

describe('dropping code onto a repository', () => {
  it('commits the whole drop at once, as the person, on the branch it was dropped on', async () => {
    const commit = vi.fn(async () => ({ commit: 'c1' }));
    const drops = new RepositoryDropService({ credential: async () => ({ token: 'their-token' }), commit, writeOnDevice: vi.fn() });
    expect(await drops.drop({ ownerId: 'u1', giteaOwner: 'koala-u1', giteaRepo: 'shop' }, files, { ref: 'story-1' })).toEqual({ ok: true, paths: ['src/a.ts', 'logo.png'], commit: 'c1' });
    expect(commit).toHaveBeenCalledWith('their-token', 'koala-u1', 'shop', files, 'Add 2 files', 'story-1');
  });

  it('writes each file, bytes intact, into the folder on the person\'s machine when the project lives there', async () => {
    const writeOnDevice = vi.fn(async (_device: string, _owner: string, _leaf: string, _target: string, _bytes: Buffer) => undefined);
    const drops = new RepositoryDropService({ credential: vi.fn(), commit: vi.fn(), writeOnDevice });
    expect(await drops.drop({ ownerId: 'u1', executionTarget: { kind: 'local-device', deviceId: 'd1', path: 'shop' } }, files)).toEqual({ ok: true, paths: ['src/a.ts', 'logo.png'] });
    expect(writeOnDevice.mock.calls.map((call) => [call[0], call[1], call[3], call[4]])).toEqual([['d1', 'u1', 'shop/src/a.ts', files[0]!.bytes], ['d1', 'u1', 'shop/logo.png', files[1]!.bytes]]);
  });

  it('says so when there is no repository', async () => {
    const drops = new RepositoryDropService({ credential: vi.fn(), commit: vi.fn(), writeOnDevice: vi.fn() });
    expect(await drops.drop({ ownerId: 'u1' }, files)).toEqual({ ok: false, why: 'This project has no repository to drop files into.' });
  });
});
