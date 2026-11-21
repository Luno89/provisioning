import { describe, it, expect } from 'vitest';
import { resolveWebTools, type WebToolsDeps } from './web-tools-resolver.js';

const deps = (over: Partial<WebToolsDeps> = {}): WebToolsDeps => ({ settings: {}, ...over });

describe('the web tools a run gets', () => {
  it('search with the instance\'s own SearXNG and read pages with its own Crawl4AI, from its settings', async () => {
    const d = deps({ settings: { searxngUrl: 'http://searxng:8080', crawl4aiUrl: 'http://crawl4ai:11235', crawl4aiToken: 'tok' } });
    expect((await resolveWebTools(d)).sources).toEqual({ search: 'searxng', fetch: 'crawl4ai' });
  });

  it('search and read with nothing where the settings name no SearXNG or Crawl4AI', async () => {
    expect((await resolveWebTools(deps())).sources).toEqual({ search: 'none', fetch: 'none' });
  });

  it('read no pages with a Crawl4AI whose token is not set', async () => {
    expect((await resolveWebTools(deps({ settings: { crawl4aiUrl: 'http://crawl4ai:11235' } }))).sources.fetch).toBe('none');
  });
});
