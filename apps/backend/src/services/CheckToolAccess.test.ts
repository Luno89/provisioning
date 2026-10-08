import { describe, it, expect, vi } from 'vitest';
import { AxiosError, AxiosHeaders, type AxiosInstance } from 'axios';
import { httpCheckAccess } from './CheckToolAccess.js';

const failed = (status: number, data: unknown) => new AxiosError('request failed', String(status), undefined, undefined, { status, data, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } });

function client(over: Partial<Record<'get' | 'put' | 'post' | 'delete', (...args: unknown[]) => Promise<unknown>>> = {}) {
  const instance = {
    get: vi.fn(async (url: string) => (url.endsWith('/scenarios') ? { data: { scenarios: [{ id: 'a' }] } } : { data: { id: 'r1', state: 'done' } })),
    put: vi.fn(async (_url: string, body: { id: string }) => ({ data: { scenario: { id: body.id } } })),
    post: vi.fn(async () => ({ data: { id: 'r9' } })),
    delete: vi.fn(async () => ({ data: { ok: true } })),
    ...over,
  };
  const asOwner = vi.fn(async () => instance as unknown as AxiosInstance);
  return { instance, asOwner, access: httpCheckAccess(asOwner) };
}

describe('the check tools acting as the person through the API', () => {
  it('acts as the owner of the run, through the same routes the Checks page uses', async () => {
    const { instance, asOwner, access } = client();
    expect(await access.scenarios('bo')).toEqual([{ id: 'a' }]);
    expect(await access.save('bo', { id: 'new-one' })).toEqual({ saved: 'new-one' });
    expect(await access.start('bo', { only: ['new-one'] })).toEqual({ runId: 'r9' });
    expect(asOwner).toHaveBeenCalledWith('bo');
    expect(instance.put).toHaveBeenCalledWith('/evals/level2/scenarios/new-one', { id: 'new-one' });
    expect(instance.post).toHaveBeenCalledWith('/evals/level2/runs', { only: ['new-one'] });
  });

  it('hands back every problem a check was refused for, and why a run did not start', async () => {
    const { access } = client({
      put: async () => { throw failed(400, { error: 'The scenario has problems', problems: ['a check needs a name', 'it expects nothing'] }); },
      post: async () => { throw failed(400, { error: 'there is no scenario called "ghost"' }); },
    });
    expect(await access.save('bo', { id: 'x' })).toEqual({ problems: ['a check needs a name', 'it expects nothing'] });
    expect(await access.save('bo', {})).toEqual({ problems: ['a check needs an id: lower-case words joined by dashes'] });
    expect(await access.start('bo', { only: ['ghost'] })).toEqual({ problem: 'there is no scenario called "ghost"' });
  });

  it('says a run or check is not there rather than failing', async () => {
    const { access } = client({ get: async () => { throw failed(404, { error: 'none' }); }, delete: async () => { throw failed(404, { error: 'none' }); } });
    expect(await access.run('bo', 'nope')).toBeUndefined();
    expect(await access.remove('bo', 'nope')).toBe(false);
  });

  it('lets a server fault through, rather than passing it off as a refusal', async () => {
    const { access } = client({ post: async () => { throw failed(500, { error: 'boom' }); } });
    await expect(access.start('bo', { only: ['a'] })).rejects.toThrow();
  });
});
