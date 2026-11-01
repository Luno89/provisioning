import { describe, it, expect, vi } from 'vitest';
import { resolveWebTools, type WebToolsDeps } from './web-tools-resolver.js';
import type { DeploymentMetadata } from '../../platform/index.js';

const dep = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({
  id: 'd1', name: 'Koala Search', appType: 'searxng', status: 'running', clusterId: 'c1', strategy: 'helm', ...over,
});

const deps = (deployments: DeploymentMetadata[], over: Partial<WebToolsDeps> = {}) => ({
  db: { getDeployments: vi.fn(async () => deployments) },
  serviceUrl: vi.fn<WebToolsDeps['serviceUrl']>(async (_c, _k, _kc, t) => `http://localhost:4${t.remotePort}/`),
  kubeconfigFor: vi.fn(async () => '/tmp/kubeconfig'),
  env: {},
  ...over,
}) satisfies WebToolsDeps;

describe('resolving a deployed service', () => {
  it('reaches into the deployment and uses it', async () => {
    const d = deps([dep()]);
    const tools = await resolveWebTools(d);

    expect(tools.sources.search).toBe('searxng');
    expect(d.serviceUrl).toHaveBeenCalledWith('c1', 'searxng-d1', '/tmp/kubeconfig',
      { service: 'searxng', namespace: 'koala-search', remotePort: 8080 });
  });

  it('ignores a deployment that is not running', async () => {
    const tools = await resolveWebTools(deps([dep({ status: 'deploying' })]));
    expect(tools.sources.search).toBe('duckduckgo');
  });

  it('falls back rather than throwing when the forward cannot be established', async () => {
    const d = deps([dep()], { serviceUrl: vi.fn(async () => { throw new Error('no such service'); }) });

    await expect(resolveWebTools(d)).resolves.toMatchObject({ sources: { search: 'duckduckgo' } });
  });

  it('falls back when the cluster has no kubeconfig', async () => {
    const d = deps([dep()], { kubeconfigFor: vi.fn(async () => undefined) });
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
