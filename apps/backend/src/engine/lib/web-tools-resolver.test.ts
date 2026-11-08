import { describe, it, expect, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { resolveWebTools, webToolsDepsFrom, type WebToolsDeps } from './web-tools-resolver.js';
import type { DeploymentMetadata } from '../../platform/index.js';

const dep = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({
  id: 'd1', name: 'Koala Search', appType: 'searxng', status: 'running', clusterId: 'c1', strategy: 'helm', ...over,
});

const deps = (deployments: DeploymentMetadata[], over: Partial<WebToolsDeps> = {}) => ({
  db: { getDeployments: vi.fn(async () => deployments) },
  serviceUrl: vi.fn<WebToolsDeps['serviceUrl']>(async (_c, _k, t) => `http://localhost:4${t.remotePort}/`),
  env: {},
  ...over,
}) satisfies WebToolsDeps;

describe('resolving a deployed service', () => {
  it('reaches into the deployment and uses it', async () => {
    const d = deps([dep()]);
    const tools = await resolveWebTools(d);

    expect(tools.sources.search).toBe('searxng');
    expect(d.serviceUrl).toHaveBeenCalledWith('c1', 'searxng-d1', { service: 'searxng', namespace: 'koala-search', remotePort: 8080 });
  });

  it('ignores a deployment that is not running', async () => {
    const tools = await resolveWebTools(deps([dep({ status: 'deploying' })]));
    expect(tools.sources.search).toBe('duckduckgo');
  });

  it('falls back rather than throwing when the forward cannot be established', async () => {
    const d = deps([dep()], { serviceUrl: vi.fn(async () => { throw new Error('no such service'); }) });

    await expect(resolveWebTools(d)).resolves.toMatchObject({ sources: { search: 'duckduckgo' } });
  });

  it('falls back when the cluster cannot be reached', async () => {
    const d = deps([dep()], { serviceUrl: vi.fn(async () => { throw new Error('c1 is stopped until something runs on it'); }) });
    expect((await resolveWebTools(d)).sources.search).toBe('duckduckgo');
  });

  it('does not route one owner through another owner\'s service', async () => {
    const d = deps([dep({ ownerId: 'someone-else' })]);
    expect((await resolveWebTools(d, 'me')).sources.search).toBe('duckduckgo');
  });

  it('uses an unowned deployment for anyone', async () => {
    expect((await resolveWebTools(deps([dep()]), 'me')).sources.search).toBe('searxng');
  });
});

describe('crawl4ai credentials', () => {
  const untokened = () => dep({ id: 'c9', name: 'crawler', appType: 'crawl4ai' });
  const crawl = () => ({ ...untokened(), crawl4aiApiToken: 'tok' });

  it('pairs the deployment with its own stored token', async () => {
    expect((await resolveWebTools(deps([crawl()]))).sources.fetch).toBe('crawl4ai');
  });

  it('will not use a deployment whose token was never stored', async () => {
    expect((await resolveWebTools(deps([untokened()]))).sources.fetch).toBe('strip-tags');
  });

  it('never pairs a deployment URL with an env var token', async () => {
    const d = deps([untokened()], { env: { CRAWL4AI_API_TOKEN: 'unrelated' } });

    expect((await resolveWebTools(d)).sources.fetch).toBe('strip-tags');
  });

  it('uses the env pair when nothing is deployed', async () => {
    const d = deps([], { env: { CRAWL4AI_URL: 'http://c4:11235', CRAWL4AI_API_TOKEN: 'tok' } });
    expect((await resolveWebTools(d)).sources.fetch).toBe('crawl4ai');
  });
});

describe('precedence', () => {
  it('prefers a running deployment over an environment variable', async () => {
    const d = deps([dep()], { env: { SEARXNG_URL: 'http://elsewhere:8080' } });
    await resolveWebTools(d);

    expect(d.serviceUrl).toHaveBeenCalled();
  });

  it('survives the database being unavailable', async () => {
    const d = deps([], { db: { getDeployments: vi.fn(async () => { throw new Error('mongo down'); }) } });
    await expect(resolveWebTools(d)).resolves.toMatchObject({ sources: { search: 'duckduckgo' } });
  });
});

describe('the deps a process builds', () => {
  it('reach a deployment\'s cluster through the proxy by its id', async () => {
    const proxy = mock<{ serviceUrl: WebToolsDeps['serviceUrl'] }>();
    proxy.serviceUrl.mockResolvedValue('http://127.0.0.1:41000/');
    const built = webToolsDepsFrom({ getDeployments: async () => [dep()] }, proxy);
    expect((await resolveWebTools({ ...built, env: {} })).sources.search).toBe('searxng');
    expect(proxy.serviceUrl).toHaveBeenCalledWith('c1', 'searxng-d1', { service: 'searxng', namespace: 'koala-search', remotePort: 8080 });
  });

  it('pass on the proxy\'s refusal, which leaves the service out', async () => {
    const proxy = mock<{ serviceUrl: WebToolsDeps['serviceUrl'] }>();
    proxy.serviceUrl.mockRejectedValue(new Error('there is no cluster c1'));
    const built = webToolsDepsFrom({ getDeployments: async () => [dep()] }, proxy);
    await expect(built.serviceUrl('c1', 'searxng-d1', { service: 'searxng', namespace: 'koala-search', remotePort: 8080 })).rejects.toThrow('there is no cluster c1');
    expect((await resolveWebTools({ ...built, env: {} })).sources.search).toBe('duckduckgo');
  });
});
