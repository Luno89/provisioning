import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import { GiteaService } from './GiteaService.js';
import { encryptValue } from '../../platform/lib/crypto.js';

const KEY = 'test-master-key-for-unit-tests-only';
const BASE = 'http://10.0.0.130:31737';

function service() {
  const gitea = new GiteaService({} as never, KEY, '/tmp/kubeconfig');
  vi.spyOn(gitea as any, 'resolveBaseUrl').mockResolvedValue(BASE as never);
  vi.spyOn(gitea as any, 'readAdminPassword').mockResolvedValue('admin-pass' as never);
  return gitea;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Gitea users are private', () => {
  it('makes a new account private', async () => {
    const gitea = service();
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response('{}', { status: 201 }); }));
    await gitea.createUserAccount('koala-bo', 'bo@example.com');
    expect(sent[0]).toMatchObject({ username: 'koala-bo', email: 'bo@example.com', visibility: 'private' });
  });

  it('reads every page of users and patches only those not private yet', async () => {
    const gitea = service();
    const first = Array.from({ length: 50 }, (_, index) => ({ login: `u${index}`, visibility: 'private' }));
    first[7] = { login: 'u7', visibility: 'public' };
    const asked: { path: string; init?: RequestInit | undefined }[] = [];
    vi.spyOn(gitea as any, 'apiFetch').mockImplementation((async (path: string, init?: RequestInit) => {
      asked.push({ path, init });
      if (path.includes('page=1&')) return new Response(JSON.stringify(first));
      if (path.includes('page=2&')) return new Response(JSON.stringify([{ login: 'late', login_name: 'late', source_id: 0, visibility: 'limited' }]));
      return new Response('{}');
    }) as never);
    expect(await gitea.makeUsersPrivate()).toEqual(['u7', 'late']);
    const patches = asked.filter((call) => call.init?.method === 'PATCH');
    expect(patches.map((call) => call.path)).toEqual(['/api/v1/admin/users/u7', '/api/v1/admin/users/late']);
    expect(JSON.parse(String(patches[0]!.init!.body))).toEqual({ login_name: 'u7', source_id: 0, visibility: 'private' });
    expect(asked.filter((call) => call.path.startsWith('/api/v1/admin/users?'))).toHaveLength(2);
  });

  it('tries every user and then says which Gitea refused', async () => {
    const gitea = service();
    vi.spyOn(gitea as any, 'apiFetch').mockImplementation((async (path: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify([{ login: 'a' }, { login: 'b' }]));
      return path.endsWith('/a') ? new Response('nope', { status: 422 }) : new Response('{}');
    }) as never);
    await expect(gitea.makeUsersPrivate()).rejects.toThrow(/a \(HTTP 422: nope\) private; 1 made private/);
  });

  it('says so when Gitea will not list its users', async () => {
    const gitea = service();
    vi.spyOn(gitea as any, 'apiFetch').mockResolvedValue(new Response('down', { status: 502 }) as never);
    await expect(gitea.makeUsersPrivate()).rejects.toThrow(/would not list its users \(HTTP 502\)/);
  });
});

describe('the registry login Koala pulls its images with', () => {
  it('mints a read-only package token for the bot once, keeps it encrypted, and hands it back for every address', async () => {
    const gitea = service();
    vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('ENOENT'));
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const written: { file: string; content: string }[] = [];
    vi.spyOn(fs, 'writeFile').mockImplementation((async (file: string, content: string) => { written.push({ file, content }); }) as never);
    const mint = vi.spyOn(gitea as any, 'mintUserToken').mockResolvedValue({ name: 'registry-pull-1', token: 'pull-token' } as never);
    const [one, two] = await Promise.all([gitea.registryLogin(), gitea.registryLogin()]);
    expect(one).toEqual({ hosts: { push: '10.0.0.130:31737', pull: '10.0.0.130:31737' }, username: 'provisioning-bot', password: 'pull-token' });
    expect(two).toBe(one);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith('provisioning-bot', 'admin-pass', 'registry-pull', ['read:package']);
    expect(written[0]!.file).toMatch(/\.gitea-pull-token$/);
    expect(written[0]!.content).not.toContain('pull-token');
  });

  it('reuses the kept token while the registry accepts it, and mints another once it does not', async () => {
    const kept = encryptValue('kept-token', KEY);
    vi.spyOn(fs, 'readFile').mockResolvedValue(kept as never);
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    const auths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      auths.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
      return new Response('', { status: 200 });
    }));
    const accepted = service();
    expect((await accepted.registryLogin()).password).toBe('kept-token');
    expect(auths).toEqual([`${BASE}/v2/ Basic ${Buffer.from('provisioning-bot:kept-token').toString('base64')}`]);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const refused = service();
    vi.spyOn(refused as any, 'mintUserToken').mockResolvedValue({ name: 'registry-pull-2', token: 'fresh-token' } as never);
    expect((await refused.registryLogin()).password).toBe('fresh-token');
  });
});
