import { describe, it, expect, vi, afterEach } from 'vitest';
import { GiteaConflictError, GiteaService } from './GiteaService.js';

type Call = { url: string; method: string; body?: Record<string, unknown> };

function serviceAnswering(answer: (call: Call) => Response) {
  const service = new GiteaService({} as any, 'master-key', '/tmp/kubeconfig');
  vi.spyOn(service as any, 'resolveBaseUrl').mockResolvedValue('http://gitea.test');
  vi.spyOn(service as any, 'readAdminPassword').mockResolvedValue('pw');
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    return answer(call);
  }));
  return { service, calls };
}

const existing = (content: string) => new Response(JSON.stringify({ sha: 'old-sha', content: Buffer.from(content).toString('base64') }), { status: 200 });
const committed = () => new Response(JSON.stringify({ commit: { sha: 'new-commit' } }), { status: 201 });
const encoded = (text: string) => Buffer.from(text).toString('base64');

afterEach(() => vi.unstubAllGlobals());

describe('GiteaService.putFile', () => {
  it('creates a file the branch does not have', async () => {
    const { service, calls } = serviceAnswering((call) => (call.method === 'GET' ? new Response('', { status: 404 }) : committed()));
    expect(await service.putFile('koala-u1', 'shop', '.koala/workspace.json', '{}\n', 'Workspace: add', 'main')).toEqual({ changed: true, commit: 'new-commit' });
    expect(calls.at(-1)).toEqual({ url: 'http://gitea.test/api/v1/repos/koala-u1/shop/contents/.koala/workspace.json', method: 'POST', body: { content: encoded('{}\n'), message: 'Workspace: add', branch: 'main' } });
  });

  it('replaces one it has, naming the version it replaces', async () => {
    const { service, calls } = serviceAnswering((call) => (call.method === 'GET' ? existing('{}\n') : committed()));
    expect(await service.putFile('koala-u1', 'shop', '.koala/workspace.json', '{"languages":["python"]}\n', 'Workspace: add', 'main')).toEqual({ changed: true, commit: 'new-commit' });
    expect(calls[0]!.url).toBe('http://gitea.test/api/v1/repos/koala-u1/shop/contents/.koala/workspace.json?ref=main');
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { sha: 'old-sha', branch: 'main' } });
  });

  it('commits nothing when the file already says exactly this', async () => {
    const { service, calls } = serviceAnswering(() => existing('{}\n'));
    expect(await service.putFile('koala-u1', 'shop', '.koala/workspace.json', '{}\n', 'Workspace: add', 'main')).toEqual({ changed: false });
    expect(calls).toHaveLength(1);
  });

  it('refuses when the file changed under it, rather than overwriting', async () => {
    const { service } = serviceAnswering((call) => (call.method === 'GET' ? existing('{}\n') : new Response('sha mismatch', { status: 409 })));
    await expect(service.putFile('koala-u1', 'shop', '.koala/workspace.json', '[]', 'm', 'main')).rejects.toBeInstanceOf(GiteaConflictError);
  });
});
