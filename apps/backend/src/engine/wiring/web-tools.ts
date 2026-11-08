import { publicAddressProblem, publicFetch, roleFromEnv, type Database } from '../../platform/index.js';
import { corpusEndpointsWith, crawlEndpointWith, resolveWebTools, webToolsDepsFrom, type CorpusEndpoints, type WebToolsDeps } from '../lib/web-tools-resolver.js';
import type { WebTools } from '../lib/web-tools.js';
import { sharedClusterProxy, clusterAccessFrom } from '../../infrastructure/index.js';

export type { CorpusEndpoints };

export const webToolsDeps = (db: Pick<Database, 'infrastructure'>): WebToolsDeps => ({
  ...webToolsDepsFrom(db.infrastructure, clusterAccessFrom(process.env, { role: roleFromEnv(process.env).role, clusters: db.infrastructure }), sharedClusterProxy()),
  env: process.env,
  pageFetch: publicFetch,
  pageCheck: publicAddressProblem,
});

export const buildWebTools = (db: Database, ownerId?: string): Promise<WebTools> => resolveWebTools(webToolsDeps(db), ownerId);

export const crawlEndpoint = (db: Pick<Database, 'infrastructure'>, ownerId?: string): Promise<{ base: string; token: string } | undefined> =>
  crawlEndpointWith(webToolsDeps(db), ownerId);

export const corpusEndpoints = (db: Pick<Database, 'infrastructure'>, ownerId?: string): Promise<CorpusEndpoints> =>
  corpusEndpointsWith(webToolsDeps(db), ownerId);
