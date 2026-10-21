import { describe, it, expect, vi, afterEach } from 'vitest';
import { GiteaConflictError, GiteaService } from './GiteaService.js';

type Call = { url: string; method: string; body?: Record<string, unknown> };

function serviceAnswering(answer: (call: Call) => Response) {
  const service = new GiteaService({} as any, 'master-key', '/tmp/kubeconfig');
  vi.spyOn(service as any, 'resolveBaseUrl').mockResolvedValue('http://gitea.test');
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    return answer(call);
  }));
  return { service, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('GiteaService.commitDrop', () => {
  it('commits every file of a drop at once, updating what exists and creating the rest, bytes intact', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const { service, calls } = serviceAnswering((call) => {
      if (call.method === 'GET') return call.url.includes('src/app.ts') ? new Response(JSON.stringify({ sha: 'old', type: 'file' }), { status: 200 }) : new Response('', { status: 404 });
      return new Response(JSON.stringify({ commit: { sha: 'c1' } }), { status: 201 });
    });
    expect(await service.commitDrop('tok', 'koala-u1', 'shop', [{ path: 'src/app.ts', bytes: Buffer.from('x') }, { path: 'public/logo.png', bytes: png }], 'Add files', 'story-1')).toEqual({ commit: 'c1' });
    expect(calls.filter((call) => call.method === 'GET').map((call) => call.url)).toEqual([
      'http://gitea.test/api/v1/repos/koala-u1/shop/contents/src/app.ts?ref=story-1',
      'http://gitea.test/api/v1/repos/koala-u1/shop/contents/public/logo.png?ref=story-1',
    ]);
    expect(calls.at(-1)).toEqual({ url: 'http://gitea.test/api/v1/repos/koala-u1/shop/contents', method: 'POST', body: { message: 'Add files', branch: 'story-1', files: [
      { operation: 'update', path: 'src/app.ts', content: Buffer.from('x').toString('base64'), sha: 'old' },
      { operation: 'create', path: 'public/logo.png', content: png.toString('base64') },
    ] } });
  });

  it('refuses a file where the repository has a folder, and says a race is a conflict', async () => {
    const folder = serviceAnswering(() => new Response(JSON.stringify([{ name: 'a' }]), { status: 200 }));
    await expect(folder.service.commitDrop('tok', 'o', 'r', [{ path: 'src', bytes: Buffer.from('x') }], 'm')).rejects.toThrow(GiteaConflictError);
    const raced = serviceAnswering((call) => (call.method === 'GET' ? new Response('', { status: 404 }) : new Response('sha mismatch', { status: 409 })));
    await expect(raced.service.commitDrop('tok', 'o', 'r', [{ path: 'a.txt', bytes: Buffer.from('x') }], 'm')).rejects.toThrow('changed while it was being committed');
  });
});
