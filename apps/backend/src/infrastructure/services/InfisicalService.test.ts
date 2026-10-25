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
const IDENTITY_FILE = path.join(process.cwd(), 'data', '.infisical-machine-identity');
const SHARED_AUTH_SECRET_FILE = path.join(process.cwd(), 'data', '.infisical-auth-secret');
const unreachable = () => Promise.reject(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
const status = (code: number) => Promise.reject(Object.assign(new Error(`status ${code}`), { response: { status: code } }));

const workspaceFound = () => get.mockResolvedValueOnce({ data: { workspaces: [{ id: 'ws1', name: 'provisioning-p1' }] } });

describe('InfisicalService', () => {
  let service: InfisicalService;

  beforeEach(() => {
    files.clear();
    files.set(IDENTITY_FILE, JSON.stringify({ clientId: 'cid', clientSecret: 'cs', orgId: 'org' }));
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

  it('makes a new machine identity when Infisical refuses the stored one and is new, as after it was wiped', async () => {
    post.mockImplementation(async (url: string, body: { clientId?: string }) => {
      if (url.endsWith('/universal-auth/login')) return body.clientId === 'cid2' ? { data: { accessToken: 'fresh' } } : status(401);
      if (url.endsWith('/admin/bootstrap')) return { data: { identity: { id: 'id2', credentials: { token: 'boot' } }, organization: { id: 'org2' } } };
      if (url.endsWith('/client-secrets')) return { data: { clientSecret: 'cs2' } };
      return { data: { identityUniversalAuth: { clientId: 'cid2' } } };
    });

    expect(await service.authenticate()).toBe('fresh');
    expect(JSON.parse(files.get(IDENTITY_FILE)!)).toEqual({ clientId: 'cid2', clientSecret: 'cs2', orgId: 'org2' });
  });

  it('keeps its identity apart from the auth secret Infisical signs with, which the setup script writes', async () => {
    files.clear();
    files.set(SHARED_AUTH_SECRET_FILE, 'the signing secret the setup script wrote');
    post.mockImplementation(async (url: string) => {
      if (url.endsWith('/universal-auth/login')) return { data: { accessToken: 'fresh' } };
      if (url.endsWith('/admin/bootstrap')) return { data: { identity: { id: 'id2', credentials: { token: 'boot' } }, organization: { id: 'org2' } } };
      if (url.endsWith('/client-secrets')) return { data: { clientSecret: 'cs2' } };
      return { data: { identityUniversalAuth: { clientId: 'cid2' } } };
    });

    expect(await service.authenticate()).toBe('fresh');
    expect(JSON.parse(files.get(IDENTITY_FILE)!)).toEqual({ clientId: 'cid2', clientSecret: 'cs2', orgId: 'org2' });
    expect(files.get(SHARED_AUTH_SECRET_FILE)).toBe('the signing secret the setup script wrote');
  });

  it('carries an identity a box kept in the auth secret file into its own, leaving that file as Infisical has it', async () => {
    files.clear();
    const kept = JSON.stringify({ clientId: 'cid', clientSecret: 'cs', orgId: 'org' });
    files.set(SHARED_AUTH_SECRET_FILE, kept);
    post.mockResolvedValueOnce({ data: { accessToken: 'tok' } });

    expect(await service.authenticate()).toBe('tok');
    expect(post.mock.calls[0]?.[1]).toEqual({ clientId: 'cid', clientSecret: 'cs' });
    expect(files.get(IDENTITY_FILE)).toBe(kept);
    expect(files.get(SHARED_AUTH_SECRET_FILE)).toBe(kept);
  });

  it('says so when Infisical refuses the stored identity and is not new, keeping the file as it was', async () => {
    post.mockImplementation(async (url: string) => (url.endsWith('/admin/bootstrap') ? status(400) : status(401)));

    await expect(service.authenticate()).rejects.toThrow('refuses the machine identity');
    expect(JSON.parse(files.get(IDENTITY_FILE)!)).toEqual({ clientId: 'cid', clientSecret: 'cs', orgId: 'org' });
  });

  it('tells a reader Infisical refuses from one it cannot be asked about', async () => {
    post.mockImplementationOnce(() => status(401));
    expect(await service.readerWorks({ clientId: 'gone', clientSecret: 'x' })).toBe(false);
    post.mockResolvedValueOnce({ data: { accessToken: 'tok' } });
    expect(await service.readerWorks({ clientId: 'r', clientSecret: 'x' })).toBe(true);
    post.mockImplementationOnce(unreachable);
    await expect(service.readerWorks({ clientId: 'r', clientSecret: 'x' })).rejects.toThrow('ECONNREFUSED');
  });

  it('finds the workspace again when the one it knew is gone, rather than reading a gone workspace as an empty one', async () => {
    const gone = () => Promise.reject(Object.assign(new Error('status 404'), { response: { status: 404, data: { message: "Project with ID 'ws1' not found during bot lookup." } } }));
    const missing = () => Promise.reject(Object.assign(new Error('status 404'), { response: { status: 404, data: { message: "Secret with name 'KEY' not found" } } }));
    post.mockImplementation(async (url: string, body: { workspaceId?: string; projectName?: string }) => {
      if (url.endsWith('/universal-auth/login')) return { data: { accessToken: 'tok' } };
      if (url.endsWith('/api/v2/workspace')) return { data: { project: { id: 'ws2' } } };
      return body.workspaceId === 'ws2' ? { data: {} } : gone();
    });
    get.mockImplementation(async (url: string, options: { params?: { workspaceId?: string } }) => {
      if (url.endsWith('/api/v1/workspace')) return { data: { workspaces: [] } };
      return options.params?.workspaceId === 'ws2' ? missing() : gone();
    });
    get.mockResolvedValueOnce({ data: { workspaces: [{ id: 'ws1', name: 'provisioning-p1' }] } });

    expect(await service.getSecret('p1', 'KEY')).toBeNull();
    expect(await service.workspaceIdFor('p1')).toBe('ws2');
    await service.setSecret('p1', 'KEY', 'v');
    expect(post.mock.calls.filter(([url]) => String(url).includes('/secrets/raw/')).map(([, body]) => (body as { workspaceId: string }).workspaceId)).toEqual(['ws2']);
  });

  it('refuses to authenticate with no machine identity instead of inventing a token', async () => {
    files.clear();
    post.mockImplementation(unreachable);
    await expect(service.authenticate()).rejects.toThrow();
  });
});
