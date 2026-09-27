import { describe, it, expect, vi } from 'vitest';
import { createCorpusTools, ingestPrefix, type CorpusAccess } from './corpus-tools.js';
import type { CorpusPage } from '../../lib/corpus.js';

const page = (over: Partial<CorpusPage>): CorpusPage => ({ id: 'x', ownerId: 'u1', ingestId: 'i1', url: 'https://docs.example.com/a', host: 'docs.example.com', text: 'The retry budget is three attempts per job.', bytes: 40, fetchedAt: 't', ...over });

function tools() {
  const started: { id: string; args: unknown }[] = [];
  const access: CorpusAccess = {
    crawlerReady: async (ownerId) => ownerId === 'u1',
    start: vi.fn(async (id, args) => { started.push({ id, args }); }),
    status: vi.fn(async (id) => (id.endsWith('done')
      ? { state: 'completed' as const, receipt: { ingestId: 'i1', seed: 's', pages: 12, bytes: 20480, failed: 1, hosts: ['docs.example.com'] } }
      : { state: 'running' as const })),
    pages: vi.fn(async (filter) => [page({}), page({ ownerId: 'u2', text: 'retry budget elsewhere' })].filter((p) => p.ownerId === filter.ownerId)),
  };
  const handlers = createCorpusTools({ access, now: () => 1000 });
  const call = (name: string, parsed: Record<string, unknown>, ownerId = 'u1') => handlers[name]!({ name, parsed, driver: undefined, caller: { ownerId, projectId: 'p1' } });
  return { call, started };
}

describe('corpus tools', () => {
  it('starts a crawl under an id that names its owner', async () => {
    const { call, started } = tools();
    const out = await call('start_ingest', { url: 'https://docs.example.com', maxDepth: 2, keywords: 'retry, budget' });
    expect(out.ok).toBe(true);
    expect(started[0]).toEqual({ id: `${ingestPrefix('u1')}rs`, args: { ownerId: 'u1', url: 'https://docs.example.com', projectId: 'p1', maxDepth: 2, keywords: ['retry', 'budget'] } });
    expect((await call('start_ingest', { url: 'ftp://x' })).digest).toContain('http(s)');
    expect((await call('start_ingest', { url: 'https://x.com', maxDepth: 9 })).digest).toContain('0 to 5');
  });

  it('refuses to start without a crawler, and says how to get one', async () => {
    const { call, started } = tools();
    expect((await call('start_ingest', { url: 'https://docs.example.com' }, 'u2')).digest).toContain('propose_deploy_app with appType crawl4ai');
    expect(started).toEqual([]);
  });

  it('reports a finished crawl and refuses someone else\'s', async () => {
    const { call } = tools();
    expect((await call('ingest_status', { id: `${ingestPrefix('u1')}done` })).content).toContain('12 pages (20 KB) from docs.example.com, 1 failed');
    expect((await call('ingest_status', { id: `${ingestPrefix('u2')}done` })).digest).toContain('no crawl of yours');
  });

  it('searches only the person\'s own pages', async () => {
    const { call } = tools();
    const out = await call('search_corpus', { query: 'retry budget' });
    expect(out.content).toContain('https://docs.example.com/a');
    expect(out.digest).toBe('1 hits for "retry budget"');
  });
});
