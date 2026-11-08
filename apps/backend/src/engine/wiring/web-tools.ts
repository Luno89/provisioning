import { publicAddressProblem, publicFetch, type Database, type WebToolSettings } from '../../platform/index.js';
import { corpusEndpointsWith, crawlEndpointWith, resolveWebTools, webToolsDepsFrom, type CorpusEndpoints, type ProxyTarget, type WebToolsDeps } from '../lib/web-tools-resolver.js';
import type { WebTools } from '../lib/web-tools.js';

export type { CorpusEndpoints };

export interface WebToolsPlace {
  db: Pick<Database, 'infrastructure'>;
  proxy: { serviceUrl(clusterId: string, serviceKey: string, target: ProxyTarget): Promise<string> };
  settings: WebToolSettings;
}

export const webToolsDeps = (place: WebToolsPlace): WebToolsDeps => ({
  ...webToolsDepsFrom(place.db.infrastructure, place.proxy),
  settings: place.settings,
  pageFetch: publicFetch,
  pageCheck: publicAddressProblem,
});

export const buildWebTools = (place: WebToolsPlace, ownerId?: string): Promise<WebTools> => resolveWebTools(webToolsDeps(place), ownerId);

export const crawlEndpoint = (place: WebToolsPlace, ownerId?: string): Promise<{ base: string; token: string } | undefined> =>
  crawlEndpointWith(webToolsDeps(place), ownerId);

export const corpusEndpoints = (place: WebToolsPlace, ownerId?: string): Promise<CorpusEndpoints> =>
  corpusEndpointsWith(webToolsDeps(place), ownerId);
