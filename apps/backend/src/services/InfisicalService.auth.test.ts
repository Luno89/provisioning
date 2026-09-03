import { describe, it, expect, vi, beforeEach } from 'vitest';

const files = new Map<string, string>();

vi.mock('fs/promises', () => ({
  default: {
    readFile: (p: string) => (files.has(p) ? Promise.resolve(files.get(p)!) : Promise.reject(new Error('ENOENT'))),
    writeFile: (p: string, data: string) => { files.set(p, data); return Promise.resolve(); },
    mkdir: () => Promise.resolve(),
  },
}));

const post = vi.fn();
const get = vi.fn();
const patch = vi.fn();
vi.mock('axios', () => ({
  default: { post: (...a: any[]) => post(...a), get: (...a: any[]) => get(...a), patch: (...a: any[]) => patch(...a) },
}));

import path from 'path';
import { InfisicalService } from './InfisicalService.js';

const AUTH_SECRET_FILE = path.join(process.cwd(), 'data', '.infisical-auth-secret');

/**
 * Regression for real bugs found live: /api/v1/auth/login 404s on this Infisical version, and
 * /admin/bootstrap 400s "already been set up" on every call after the first — so caching its
 * one-off identity token doesn't survive losing the cache. Fixed by minting a permanent Universal
 * Auth machine identity (clientId/clientSecret) once and persisting THAT. Also, our own project
 * ids are never real Infisical workspace ids.
 */
function mockFirstTimeProvisioning() {
  post
    .mockResolvedValueOnce({ data: { identity: { id: 'id1', credentials: { token: 'boottok' } }, organization: { id: 'org1' } } })
    .mockResolvedValueOnce({ data: { identityUniversalAuth: { clientId: 'cid1' } } })
    .mockResolvedValueOnce({ data: { clientSecret: 'csecret1' } })
    .mockResolvedValueOnce({ data: { accessToken: 'atok1' } });
}

describe('InfisicalService auth + workspace resolution', () => {
  const masterKey = 'test-jwt-secret-key-that-is-at-least-32-chars-long';
  let service: InfisicalService;

  beforeEach(() => {
    files.clear();
    post.mockReset();
    get.mockReset();
    patch.mockReset();
    service = new InfisicalService({ runKubectl: vi.fn() }, masterKey, '/tmp/kc.yaml', 'http://vault:8080');
  });

  it('provisions a permanent machine identity on first use and persists it', async () => {
    mockFirstTimeProvisioning();

    const token = await service.authenticate();
    expect(token).toBe('atok1');
    expect(JSON.parse(files.get(AUTH_SECRET_FILE)!)).toEqual({ clientId: 'cid1', clientSecret: 'csecret1', orgId: 'org1' });
  });

  it('reuses persisted credentials instead of re-provisioning', async () => {
    mockFirstTimeProvisioning();
    await service.authenticate();
    expect(post).toHaveBeenCalledTimes(4);

    post.mockResolvedValueOnce({ data: { accessToken: 'atok2' } });
    const fresh = new InfisicalService({ runKubectl: vi.fn() }, masterKey, '/tmp/kc.yaml', 'http://vault:8080');
    const token = await fresh.authenticate();
    expect(token).toBe('atok2');
    expect(post).toHaveBeenCalledTimes(5); // one more call: universal-auth login, no re-provisioning
  });

  it('resolves a real workspace id instead of using the platform project id directly', async () => {
    mockFirstTimeProvisioning();
    get.mockResolvedValueOnce({ data: { workspaces: [] } });
    post.mockResolvedValueOnce({ data: { project: { id: 'real-ws-id' } } });
    post.mockResolvedValueOnce({ data: { secret: { secretValue: 'ok' } } });

    await service.setSecret('our-platform-project-id', 'KEY', 'val');

    const secretCall = post.mock.calls.find((c) => String(c[0]).includes('/secrets/raw/'));
    expect(secretCall?.[1]).toMatchObject({ workspaceId: 'real-ws-id' });
  });

  it('falls back to PATCH when the raw endpoint 400s because the key already exists', async () => {
    mockFirstTimeProvisioning();
    get.mockResolvedValueOnce({ data: { workspaces: [{ id: 'ws1', name: 'provisioning-p1' }] } });
    post.mockRejectedValueOnce({ response: { status: 400 }, message: 'Secret already exists' });
    patch.mockResolvedValueOnce({ data: { secret: {} } });

    const res = await service.setSecret('p1', 'KEY', 'new-value');

    expect(res.success).toBe(true);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[1]).toMatchObject({ workspaceId: 'ws1', secretValue: 'new-value' });
  });
});
