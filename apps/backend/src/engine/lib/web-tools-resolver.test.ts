import { describe, it, expect, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { corpusEndpointsWith, resolveWebTools, webToolsDepsFrom, type WebToolsDeps } from './web-tools-resolver.js';
import { CorpusStoreDown } from './corpus-stores.js';
import type { DeploymentMetadata } from '../../platform/index.js';

const dep = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({
  id: 'd1', name: 'Koala Search', appType: 'searxng', status: 'running', clusterId: 'c1', strategy: 'helm', ...over,
});

const deps = (deployments: DeploymentMetadata[], over: Partial<WebToolsDeps> = {}) => ({
  db: { getDeployments: vi.fn(async () => deployments) },
  serviceUrl: vi.fn<WebToolsDeps['serviceUrl']>(async (_c, _k, t) => `http://localhost:4${t.remotePort}/`),
  settings: {},
  ...over,
}) satisfies WebToolsDeps;

describe('the web tools a run gets', () => {
  it('search with the instance\'s own SearXNG and read pages with its own Crawl4AI, from its settings', async () => {
    const d = deps([], { settings: { searxngUrl: 'http://searxng:8080', crawl4aiUrl: 'http://crawl4ai:11235', crawl4aiToken: 'tok' } });
    expect((await resolveWebTools(d)).sources).toEqual({ search: 'searxng', fetch: 'crawl4ai' });
  });

  it('never use a SearXNG or Crawl4AI someone deployed as an app, running or not, and never read the deployments to find one', async () => {
    const d = deps([dep(), { ...dep({ id: 'c9', appType: 'crawl4ai' }), crawl4aiApiToken: 'tok' }]);
    expect((await resolveWebTools(d)).sources).toEqual({ search: 'none', fetch: 'none' });
    expect(d.db.getDeployments).not.toHaveBeenCalled();
    expect(d.serviceUrl).not.toHaveBeenCalled();
  });

  it('read no pages with a Crawl4AI whose token is not set', async () => {
    expect((await resolveWebTools(deps([], { settings: { crawl4aiUrl: 'http://crawl4ai:11235' } }))).sources.fetch).toBe('none');
  });
});

describe('the deps a process builds', () => {
  it('reach a deployment\'s cluster through the proxy by its id', async () => {
    const proxy = mock<{ serviceUrl: WebToolsDeps['serviceUrl'] }>();
    proxy.serviceUrl.mockResolvedValue('http://127.0.0.1:41000/');
    const index = dep({ id: 'q9', name: 'search-index', appType: 'quickwit', ownerId: 'u1' });
    const built = webToolsDepsFrom({ getDeployments: async () => [index] }, proxy);
    expect(await corpusEndpointsWith(built, 'u1')).toEqual({ index: { base: 'http://127.0.0.1:41000' } });
    expect(proxy.serviceUrl).toHaveBeenCalledWith('c1', 'quickwit-q9', { service: 'quickwit', namespace: 'search-index', remotePort: 7280 });
  });

  it('pass on the proxy\'s refusal, which leaves the service out', async () => {
    const proxy = mock<{ serviceUrl: WebToolsDeps['serviceUrl'] }>();
    proxy.serviceUrl.mockRejectedValue(new Error('there is no cluster c1'));
    const built = webToolsDepsFrom({ getDeployments: async () => [dep()] }, proxy);
    await expect(built.serviceUrl('c1', 'searxng-d1', { service: 'searxng', namespace: 'koala-search', remotePort: 8080 })).rejects.toThrow('there is no cluster c1');
  });
});

describe('the person\'s own corpus services', () => {
  it('a Quickwit of their own that is deployed but not answering is said to be down, never taken as missing', async () => {
    const d = deps([dep({ id: 'q9', name: 'search-index', appType: 'quickwit', ownerId: 'u1' })], { serviceUrl: vi.fn<WebToolsDeps['serviceUrl']>(async () => { throw new Error('its pod is not ready'); }) });
    const failed = await corpusEndpointsWith(d, 'u1').then(() => undefined, (err: unknown) => err);
    expect(failed).toBeInstanceOf(CorpusStoreDown);
    expect((failed as Error).message).toBe('Quickwit "search-index" is deployed but not answering: its pod is not ready');
  });

  it('the deployments that cannot be read are an error, never no services', async () => {
    const d = deps([], { db: { getDeployments: vi.fn(async () => { throw new Error('the database is down'); }) } });
    await expect(corpusEndpointsWith(d, 'u1')).rejects.toThrow('the database is down');
  });

  it('someone else\'s running Quickwit is not theirs', async () => {
    expect(await corpusEndpointsWith(deps([dep({ appType: 'quickwit', ownerId: 'someone-else' })]), 'u1')).toEqual({});
  });

  it('a Quickwit with no owner is nobody\'s, so it serves no one\'s corpus', async () => {
    const d = deps([dep({ appType: 'quickwit' })]);
    expect(await corpusEndpointsWith(d, 'u1')).toEqual({});
    expect(d.serviceUrl).not.toHaveBeenCalled();
  });
});
