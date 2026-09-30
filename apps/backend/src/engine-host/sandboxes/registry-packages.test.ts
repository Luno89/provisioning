import { describe, it, expect, vi } from 'vitest';
import { createRegistryPackages, WORKSPACE_REPOSITORY } from './registry-packages.js';

const REGISTRY = '10.0.0.130:31737';
const ACCOUNT = { owner: 'provisioning-bot', username: 'provisioning-bot', password: 'secret' };
const AUTH = `Basic ${Buffer.from('provisioning-bot:secret').toString('base64')}`;

const row = (version: string, over: Record<string, unknown> = {}) => ({
  id: 1, type: 'container', name: WORKSPACE_REPOSITORY, version, created_at: '2026-09-19T13:51:47Z', ...over,
});

function setup(responses: { status?: number; statusText?: string; body?: unknown }[] = [{ body: [] }]) {
  const calls: { url: string; method: string; auth: string }[] = [];
  let at = 0;

  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), method: init?.method ?? 'GET', auth: headers.Authorization ?? '' });

    const response = (at < responses.length ? responses[at] : undefined) ?? { body: [] };
    at += 1;
    const status = response.status ?? 200;

    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: response.statusText ?? 'OK',
      json: async () => response.body ?? [],
    } as unknown as Response;
  });

  const packages = createRegistryPackages({
    registry: async () => REGISTRY,
    account: async () => ACCOUNT,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    pageSize: 2,
  });

  return { packages, calls };
}

describe('reading the workspace images the registry holds', () => {
  it('takes each tag with the date it was pushed', async () => {
    const { packages, calls } = setup([{ body: [row('aaa'), row('bbb', { created_at: '2026-09-29T15:59:38Z' })] }]);

    expect(await packages.list()).toEqual([
      { fingerprint: 'aaa', createdAt: '2026-09-19T13:51:47Z' },
      { fingerprint: 'bbb', createdAt: '2026-09-29T15:59:38Z' },
    ]);
    expect(calls[0]!.url).toContain(`http://${REGISTRY}/api/v1/packages/${ACCOUNT.owner}?type=container`);
    expect(calls[0]!.auth).toBe(AUTH);
  });

  it('follows the pages until a short one says that is all', async () => {
    const { packages, calls } = setup([{ body: [row('aaa'), row('bbb')] }, { body: [row('ccc')] }]);

    expect((await packages.list()).map((tag) => tag.fingerprint)).toEqual(['aaa', 'bbb', 'ccc']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('page=2');
  });

  it('ignores a package that is not the workspace repository', async () => {
    const { packages } = setup([{ body: [row('aaa'), row('zzz', { name: 'koala-api' })] }]);

    expect((await packages.list()).map((tag) => tag.fingerprint)).toEqual(['aaa']);
  });

  it('counts a tag once when the registry serves the same page again', async () => {
    const { packages } = setup([{ body: [row('aaa'), row('bbb')] }, { body: [row('aaa'), row('bbb')] }, { body: [] }]);

    expect((await packages.list()).map((tag) => tag.fingerprint)).toEqual(['aaa', 'bbb']);
  });

  it('says so when the registry will not list them', async () => {
    const { packages } = setup([{ status: 401, statusText: 'Unauthorized' }]);

    await expect(packages.list()).rejects.toThrow(/Could not list the workspace images: 401/);
  });
});

describe('deleting one', () => {
  it('deletes by fingerprint, as the registry account', async () => {
    const { packages, calls } = setup([{ status: 204, body: [] }]);

    await packages.remove('cfe46cd56cf6936cfbc19480fdb5a09d');

    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(
      `http://${REGISTRY}/api/v1/packages/${ACCOUNT.owner}/container/${WORKSPACE_REPOSITORY}/cfe46cd56cf6936cfbc19480fdb5a09d`,
    );
    expect(calls[0]!.auth).toBe(AUTH);
  });

  it('takes an image that is already gone as deleted', async () => {
    const { packages } = setup([{ status: 404, statusText: 'Not Found' }]);

    await expect(packages.remove('aaa')).resolves.toBeUndefined();
  });

  it('says so when a delete is refused', async () => {
    const { packages } = setup([{ status: 500, statusText: 'Server Error' }]);

    await expect(packages.remove('aaabbbcccddd')).rejects.toThrow(/Could not delete the workspace image aaabbbcccddd: 500/);
  });
});
