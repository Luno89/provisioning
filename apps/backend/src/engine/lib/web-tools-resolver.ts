import { createWebTools, type WebTools } from './web-tools.js';
import { reportingFetch, type DependencyReporter } from '../../platform/lib/dependencies.js';

export interface WebToolsDeps {
  settings?: { searxngUrl?: string | undefined; crawl4aiUrl?: string | undefined; crawl4aiToken?: string | undefined } | undefined;
  pageCheck?: ((url: string) => Promise<string | undefined>) | undefined;
  dependencies?: DependencyReporter | undefined;
  baseFetch?: typeof fetch | undefined;
}

export async function resolveWebTools(deps: WebToolsDeps): Promise<WebTools> {
  const { searxngUrl, crawl4aiUrl, crawl4aiToken } = deps.settings ?? {};
  const watched = (dependency: 'searxng' | 'crawl4ai'): typeof fetch | undefined =>
    deps.dependencies && deps.baseFetch ? reportingFetch(deps.dependencies, dependency, deps.baseFetch) : undefined;
  const searxngFetch = searxngUrl ? watched('searxng') : undefined;
  const crawl4aiFetch = crawl4aiUrl ? watched('crawl4ai') : undefined;
  return createWebTools({
    ...(deps.baseFetch ? { fetchImpl: deps.baseFetch } : {}),
    ...(searxngFetch ? { searxngFetch } : {}),
    ...(crawl4aiFetch ? { crawl4aiFetch } : {}),
    ...(deps.pageCheck ? { pageCheck: deps.pageCheck } : {}),
    ...(searxngUrl ? { searxngUrl } : {}),
    ...(crawl4aiUrl && crawl4aiToken ? { crawl4aiUrl, crawl4aiToken } : {}),
  });
}
