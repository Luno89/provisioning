import { publicAddressProblem, publicFetch, type Database } from '../../platform/index.js';
import { corpusEndpointsWith, crawlEndpointWith, resolveWebTools, webToolsDepsFrom, type CorpusEndpoints, type WebToolsDeps } from '../lib/web-tools-resolver.js';
import type { WebTools } from '../lib/web-tools.js';
import { sharedClusterProxy, ClusterService, InfrastructureService } from '../../infrastructure/index.js';

export type { CorpusEndpoints };

export const webToolsDeps = (db: Pick<Database, 'infrastructure'>): WebToolsDeps => ({
  ...webToolsDepsFrom(db.infrastructure, new ClusterService(db as never, new InfrastructureService()), sharedClusterProxy()),
  pageFetch: publicFetch,
  pageCheck: publicAddressProblem,
});

export const buildWebTools = (db: Database, ownerId?: string): Promise<WebTools> => resolveWebTools(webToolsDeps(db), ownerId);

export const crawlEndpoint = (db: Pick<Database, 'infrastructure'>, ownerId?: string): Promise<{ base: string; token: string } | undefined> =>
  crawlEndpointWith(webToolsDeps(db), ownerId);

export const corpusEndpoints = (db: Pick<Database, 'infrastructure'>, ownerId?: string): Promise<CorpusEndpoints> =>
  corpusEndpointsWith(webToolsDeps(db), ownerId);
