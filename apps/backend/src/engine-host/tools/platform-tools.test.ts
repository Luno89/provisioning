import { describe, it, expect, vi } from 'vitest';
import { createPlatformTools } from './platform-tools.js';

const caller = { ownerId: 'user-1', projectId: 'project-9' };

const run = (
  handlers: ReturnType<typeof createPlatformTools>,
  name: string,
  parsed: Record<string, unknown>,
) => handlers[name]!({ name, parsed, driver: undefined, caller });

describe('search_web', () => {
  const web = (over: Partial<{ search: unknown; fetchPage: unknown }> = {}) => ({
    search: vi.fn(async () => ({
      results: [
        { title: 'Pods are not Ready', url: 'https://example.test/pods', snippet: 'check the events' },
        { title: 'CrashLoopBackOff', url: 'https://example.test/crash' },
      ],
    })),
    fetchPage: vi.fn(async (url: string) => (url.includes('missing') ? { ok: false, text: 'HTTP error 404' } : { ok: true, text: 'the page body' })),
    ...over,
  }) as never;

  it('renders results the model can actually use', async () => {
    const tools = createPlatformTools({ web: web() });
    const outcome = await run(tools, 'search_web', { query: 'crashloop' });

    expect(outcome.ok).toBe(true);
    expect(outcome.digest).toContain('Pods are not Ready');
    expect(outcome.digest).toContain('https://example.test/pods');
    expect(outcome.digest).toContain('check the events');
  });

  it('accepts either query or q, since models use both', async () => {
    const tools = createPlatformTools({ web: web() });
    expect((await run(tools, 'search_web', { q: 'crashloop' })).ok).toBe(true);
  });

  it('asks for a query rather than searching for nothing', async () => {
    const tools = createPlatformTools({ web: web() });
    const outcome = await run(tools, 'search_web', {});

    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.digest).toContain('needs a "query"');
  });

  it('reports an empty result set as success with nothing found', async () => {
    const tools = createPlatformTools({
      web: web({ search: vi.fn(async () => ({ results: [] })) }),

    });

    const outcome = await run(tools, 'search_web', { query: 'nothing at all' });
    expect(outcome.ok).toBe(true);
    expect(outcome.digest).toContain('nothing came back');
  });

  it('passes a search error back as a failure', async () => {
    const tools = createPlatformTools({
      web: web({ search: vi.fn(async () => ({ error: 'no search provider configured' })) }),

    });

    const outcome = await run(tools, 'search_web', { query: 'x' });
    expect(outcome).toMatchObject({ ok: false, digest: 'no search provider configured' });
  });

  it('fetches a page and needs a url', async () => {
    const tools = createPlatformTools({ web: web() });

    expect(await run(tools, 'fetch_web_page', { url: 'https://example.test' })).toMatchObject({ ok: true, digest: 'the page body' });
    expect(await run(tools, 'fetch_web_page', { url: 'https://example.test/missing' })).toMatchObject({ ok: false, digest: 'HTTP error 404' });
    expect((await run(tools, 'fetch_web_page', {})).digest).toContain('needs a "url"');
  });

  it('passes a refusal from the site through so the procedure can tell it apart from a breakage', async () => {
    const tools = createPlatformTools({
      web: web({ fetchPage: vi.fn(async () => ({ ok: false, declined: true, text: 'HTTP 403: this site refused the fetch' })) }),
    });

    expect(await run(tools, 'fetch_web_page', { url: 'https://example.test' }))
      .toMatchObject({ ok: false, declined: true, digest: 'HTTP 403: this site refused the fetch' });
  });
});

describe('what gets registered', () => {
  it('offers nothing it cannot actually back', () => {
    expect(Object.keys(createPlatformTools({}))).toEqual([]);
  });

  it('offers only what it was given', () => {
    const webOnly = createPlatformTools({
      web: { search: vi.fn(async () => ({ results: [] })), fetchPage: vi.fn(async () => ({ ok: true, text: '' })) },

    });

    expect(Object.keys(webOnly).sort()).toEqual(['fetch_web_page', 'search_web']);
  });
});
