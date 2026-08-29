import { describe, it, expect, vi } from 'vitest';
import { resolveWebTools } from './web-tools-resolver.js';

const dep = (over: Record<string, unknown> = {}) => ({
  id: 'd1', name: 'Koala Search', appType: 'searxng', status: 'running', clusterId: 'c1', ...over,
} as any);

const deps = (deployments: any[], over: Record<string, unknown> = {}) => ({
  db: { getDeployments: vi.fn(async () => deployments) },
  ensurePortForward: vi.fn(async (_c: string, _k: string, _kc: string, t: any) => `http://localhost:4${t.remotePort}/`),
  kubeconfigFor: vi.fn(async () => '/tmp/kubeconfig'),
  env: {},
  ...over,
} as any);

describe('resolving a deployed service', () => {
  it('port-forwards into the deployment and uses it', async () => {
    const d = deps([dep()]);
    const tools = await resolveWebTools(d);

    expect(tools.sources.search).toBe('searxng');
    expect(d.ensurePortForward).toHaveBeenCalledWith('c1', 'searxng-d1', '/tmp/kubeconfig',
      { service: 'searxng', namespace: 'koala-search', remotePort: 8080 });
  });

  it('ignores a deployment that is not running', async () => {
    const tools = await resolveWebTools(deps([dep({ status: 'deploying' })]));
    expect(tools.sources.search).toBe('duckduckgo');
  });

  it('falls back rather than throwing when the forward cannot be established', async () => {
    const d = deps([dep()], { ensurePortForward: vi.fn(async () => { throw new Error('no such service'); }) });

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
  const crawl = (over = {}) => dep({ id: 'c9', name: 'crawler', appType: 'crawl4ai', crawl4aiApiToken: 'tok', ...over });

  it('pairs the deployment with its own stored token', async () => {
    expect((await resolveWebTools(deps([crawl()]))).sources.fetch).toBe('crawl4ai');
  });

  it('will not use a deployment whose token was never stored', async () => {
    expect((await resolveWebTools(deps([crawl({ crawl4aiApiToken: undefined })]))).sources.fetch).toBe('strip-tags');
  });

  it('never pairs a deployment URL with an env var token', async () => {
    const d = deps([crawl({ crawl4aiApiToken: undefined })], { env: { CRAWL4AI_API_TOKEN: 'unrelated' } });

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

    expect(d.ensurePortForward).toHaveBeenCalled();
  });

  it('survives the database being unavailable', async () => {
    const d = deps([], { db: { getDeployments: vi.fn(async () => { throw new Error('mongo down'); }) } });
    await expect(resolveWebTools(d)).resolves.toMatchObject({ sources: { search: 'duckduckgo' } });
  });
});
