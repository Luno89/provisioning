import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RepositoryDropService } from './RepositoryDropService.js';

const folder = mkdtempSync(path.join(tmpdir(), 'repository-drop-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const bytes = [Buffer.from('a'), Buffer.from([0, 255])];
const files = [{ path: 'src/a.ts' }, { path: 'logo.png' }].map((file, index) => {
  const source = path.join(folder, String(index));
  writeFileSync(source, bytes[index]!);
  return { ...file, source, size: bytes[index]!.length };
});

describe('dropping code onto a repository', () => {
  it('commits the whole drop at once, as the person, on the branch it was dropped on', async () => {
    const commit = vi.fn(async () => ({ commit: 'c1' }));
    const drops = new RepositoryDropService({ credential: async () => ({ token: 'their-token', username: 'koala-u1' }), commit, writeOnDevice: vi.fn() });
    expect(await drops.drop({ ownerId: 'u1', giteaOwner: 'koala-u1', giteaRepo: 'shop' }, files, { ref: 'story-1' })).toEqual({ ok: true, paths: ['src/a.ts', 'logo.png'], commit: 'c1' });
    expect(commit).toHaveBeenCalledWith({ token: 'their-token', username: 'koala-u1' }, 'koala-u1', 'shop', files, 'Add 2 files', 'story-1');
  });

  it('writes each file, bytes intact, into the folder on the person\'s machine when the project lives there', async () => {
    const writeOnDevice = vi.fn(async (_device: string, _owner: string, _leaf: string, _target: string, _bytes: Buffer) => undefined);
    const drops = new RepositoryDropService({ credential: vi.fn(), commit: vi.fn(), writeOnDevice });
    expect(await drops.drop({ ownerId: 'u1', executionTarget: { kind: 'local-device', deviceId: 'd1', path: 'shop' } }, files)).toEqual({ ok: true, paths: ['src/a.ts', 'logo.png'] });
    expect(writeOnDevice.mock.calls.map((call) => [call[0], call[1], call[3], call[4]])).toEqual([['d1', 'u1', 'shop/src/a.ts', bytes[0]], ['d1', 'u1', 'shop/logo.png', bytes[1]]]);
  });

  it('says so when there is no repository', async () => {
    const drops = new RepositoryDropService({ credential: vi.fn(), commit: vi.fn(), writeOnDevice: vi.fn() });
    expect(await drops.drop({ ownerId: 'u1' }, files)).toEqual({ ok: false, why: 'This project has no repository to drop files into.' });
  });
});
