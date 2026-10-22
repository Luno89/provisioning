import type { Database } from '../../platform/lib/db-interface.js';
import { corpusEndpointsWith, crawlEndpointWith, resolveWebTools, webToolsDepsFrom, type CorpusEndpoints, type WebToolsDeps } from '../lib/web-tools-resolver.js';
import type { WebTools } from '../lib/web-tools.js';
import { sharedClusterProxy } from '../../infrastructure/services/ClusterProxyService.js';
import { ClusterService } from '../../infrastructure/services/ClusterService.js';
import { InfrastructureService } from '../../infrastructure/services/InfrastructureService.js';

export type { CorpusEndpoints };

export const webToolsDeps = (db: Pick<Database, 'getDeployments'>): WebToolsDeps =>
  webToolsDepsFrom(db, new ClusterService(db as never, new InfrastructureService()), sharedClusterProxy());

export const buildWebTools = (db: Database, ownerId?: string): Promise<WebTools> => resolveWebTools(webToolsDeps(db), ownerId);

export const crawlEndpoint = (db: Pick<Database, 'getDeployments'>, ownerId?: string): Promise<{ base: string; token: string } | undefined> =>
  crawlEndpointWith(webToolsDeps(db), ownerId);

export const corpusEndpoints = (db: Pick<Database, 'getDeployments'>, ownerId?: string): Promise<CorpusEndpoints> =>
  corpusEndpointsWith(webToolsDeps(db), ownerId);
