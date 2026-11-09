import { describe, it, expect, vi, afterEach } from 'vitest';
import { dependencyFetch, useDependencyHttp } from './http.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('the layer\'s fetch', () => {
  it('goes out through the process\'s one client, keeping everything else it was given', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => { seen.push(init); return new Response('ok'); });
    const stop = new AbortController();

    await dependencyFetch('http://model/v1/chat/completions', { method: 'POST', body: '{}', signal: stop.signal });

    expect(seen[0]).toMatchObject({ method: 'POST', body: '{}', signal: stop.signal, dispatcher: useDependencyHttp().dispatcher });
  });

  it('is one client however often it is asked for', () => {
    expect(useDependencyHttp()).toBe(useDependencyHttp());
  });
});
