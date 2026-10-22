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
const del = vi.fn();
vi.mock('axios', () => ({
  default: {
    post: (...a: unknown[]) => post(...a),
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

import path from 'path';
import { InfisicalService } from './InfisicalService.js';

const MASTER_KEY = 'test-jwt-secret-key-that-is-at-least-32-chars-long';
const AUTH_SECRET_FILE = path.join(process.cwd(), 'data', '.infisical-auth-secret');
const unreachable = () => Promise.reject(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
const status = (code: number) => Promise.reject(Object.assign(new Error(`status ${code}`), { response: { status: code } }));

const workspaceFound = () => get.mockResolvedValueOnce({ data: { workspaces: [{ id: 'ws1', name: 'provisioning-p1' }] } });

describe('InfisicalService', () => {
  let service: InfisicalService;

  beforeEach(() => {
    files.clear();
    files.set(AUTH_SECRET_FILE, JSON.stringify({ clientId: 'cid', clientSecret: 'cs', orgId: 'org' }));
    for (const fn of [post, get, patch, del]) fn.mockReset();
    service = new InfisicalService({ runKubectl: vi.fn() }, MASTER_KEY, '/tmp/kc.yaml', 'http://vault:8080');
  });

  it('resolves the base URL from the service NodePort and the node address', async () => {
    const runKubectl = vi.fn(async (args: string[]) => (args.includes('svc')
      ? JSON.stringify({ spec: { ports: [{ name: 'http', nodePort: 31738 }] } })
      : '192.168.1.100'));
    const found = new InfisicalService({ runKubectl }, MASTER_KEY, '/tmp/kc.yaml');
    expect(await found.resolveBaseUrl()).toBe('http://192.168.1.100:31738');
  });

  it('fails a write the vault never received, and keeps no copy of the value anywhere', async () => {
    post.mockImplementation(unreachable);
    await expect(service.setSecret('p1', 'STRIPE_KEY', 'sk_live_sentinel')).rejects.toThrow();

    get.mockImplementation(unreachable);
    await expect(service.getSecret('p1', 'STRIPE_KEY')).rejects.toThrow();
  });

  it('writes to the vault and answers with a reference, never the value', async () => {
    post.mockResolvedValueOnce({ data: { accessToken: 'tok' } });
    workspaceFound();
    post.mockResolvedValueOnce({ data: {} });

    const saved = await service.setSecret('p1', 'STRIPE_KEY', 'sk_live_sentinel');

    expect(saved).toEqual({ secretReference: 'secret://p1/STRIPE_KEY' });
    expect(post.mock.calls[1]?.[1]).toMatchObject({ workspaceId: 'ws1', secretValue: 'sk_live_sentinel', environment: 'dev' });
  });

  it('reads a missing key as null, and any other failure as an error', async () => {
    post.mockResolvedValueOnce({ data: { accessToken: 'tok' } });
    workspaceFound();
    get.mockImplementationOnce(() => status(404));
    expect(await service.getSecret('p1', 'NOPE')).toBeNull();

    get.mockImplementationOnce(() => status(500));
    await expect(service.getSecret('p1', 'NOPE')).rejects.toThrow();
  });

  it('logs in again once when the access token has expired', async () => {
    post.mockResolvedValueOnce({ data: { accessToken: 'old' } });
    workspaceFound();
    get.mockImplementationOnce(() => status(401));
    post.mockResolvedValueOnce({ data: { accessToken: 'new' } });
    get.mockResolvedValueOnce({ data: { secret: { secretValue: 'v' } } });

    expect(await service.hasSecret('p1', 'KEY')).toBe(true);
    expect(get.mock.calls[2]?.[1]).toMatchObject({ headers: { Authorization: 'Bearer new' } });
  });

  it('lists keys and references without any part of a value', async () => {
    post.mockResolvedValueOnce({ data: { accessToken: 'tok' } });
    workspaceFound();
    get.mockResolvedValueOnce({ data: { secrets: [{ secretKey: 'STRIPE_KEY', secretValue: 'sk_live_sentinel', version: 2 }] } });

    const list = await service.listSecrets('p1');

    expect(list).toEqual([{ key: 'STRIPE_KEY', secretReference: 'secret://p1/STRIPE_KEY', version: 2 }]);
    expect(JSON.stringify(list)).not.toContain('sk_live');
  });

  it('deletes with the workspace in the body, the only place Infisical reads it', async () => {
    post.mockResolvedValueOnce({ data: { accessToken: 'tok' } });
    workspaceFound();
    del.mockResolvedValueOnce({ data: {} });

    await service.deleteSecret('p1', 'KEY');

    expect(del.mock.calls[0]?.[1]).toMatchObject({ data: { workspaceId: 'ws1', environment: 'dev' } });
  });

  it('refuses to authenticate with no machine identity instead of inventing a token', async () => {
    files.clear();
    post.mockImplementation(unreachable);
    await expect(service.authenticate()).rejects.toThrow();
  });
});
