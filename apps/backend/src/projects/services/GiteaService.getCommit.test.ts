import { describe, it, expect, vi } from 'vitest';
import { GiteaService } from './GiteaService.js';

interface GiteaInternals {
  apiFetch(path: string, init?: RequestInit): Promise<Response>;
}

const unused = (): never => { throw new Error('not used by this test'); };

function serviceWithApiFetch(handler: (path: string) => Promise<Response>) {
  const service = new GiteaService({ runKubectl: unused, getK3dServerIp: unused }, 'master-key', '/tmp/kubeconfig');
  vi.spyOn(service as unknown as GiteaInternals, 'apiFetch').mockImplementation((path) => handler(path));
  return service;
}

describe('GiteaService.getCommit', () => {
  it('returns the commit message, author and date', async () => {
    const service = serviceWithApiFetch(async () => new Response(JSON.stringify({
      commit: { message: 'Fix the thing', author: { name: 'Ada', date: '2026-01-01T00:00:00Z' } },
    }), { status: 200 }));

    const commit = await service.getCommit('acme', 'demo', 'abc123');
    expect(commit).toEqual({ message: 'Fix the thing', author: 'Ada', date: '2026-01-01T00:00:00Z' });
  });

  it('returns null for a commit that does not exist', async () => {
    const service = serviceWithApiFetch(async () => new Response('not found', { status: 404 }));
    expect(await service.getCommit('acme', 'demo', 'missing')).toBeNull();
  });

  it('throws on an unexpected Gitea error', async () => {
    const service = serviceWithApiFetch(async () => new Response('boom', { status: 500 }));
    await expect(service.getCommit('acme', 'demo', 'abc123')).rejects.toThrow(/HTTP 500/);
  });
});
