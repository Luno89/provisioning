import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeProcesses, nodeStreams } from '../../platform/index.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess, InfrastructureService, PLATFORM_PLAN, terraformPlacesFor, type PlatformServicePlan, type Reach } from '../../infrastructure/index.js';
import { privateCluster, type PrivateCluster } from '../../infrastructure/testing/private-cluster.js';
import { testDataDir } from '../../platform/testing/data-dir.js';
import type { PlatformPlace } from '../platform-provision.js';

export interface PlatformCluster {
  k3s: PrivateCluster;
  access: ClusterAccess;
  own: Reach;
  place: PlatformPlace;
  infra: InfrastructureService;
}

export const platformPlan = (key: string): PlatformServicePlan => {
  const found = PLATFORM_PLAN.find((each) => each.key === key);
  if (!found) throw new Error(`Koala has no platform service ${key}`);
  return found;
};

export const quickly = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, Math.min(ms, 500)); });

export async function platformCluster(file: string): Promise<PlatformCluster> {
  const k3s = await privateCluster(file);
  const access = new ClusterAccess({
    here: { koalaMachineId: 'desk', root: false },
    folder: mkdtempSync(join(tmpdir(), 'koala-platform-')),
    processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: k3s.account,
  });
  const own = access.own();
  const dataDir = testDataDir();
  mkdirSync(dataDir, { recursive: true });
  return {
    k3s,
    access,
    own,
    place: { reach: own, koalaNamespace: 'nowrinkles', pool: false, dataDir, crawl4aiToken: 'crawlToken40', qdrantApiKey: 'qdrantKey40' },
    infra: new InfrastructureService(terraformPlacesFor({ kind: 'local' }, dataDir)),
  };
}
