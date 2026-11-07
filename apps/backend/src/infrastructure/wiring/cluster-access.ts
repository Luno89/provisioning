import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nodeProcesses, nodeStreams, type PlatformRole, type SecretKey } from '../../platform/index.js';
import { serviceAccountFrom } from '../lib/cluster-places.js';
import { ClusterAccess } from '../services/ClusterAccess.js';
import type { InfrastructureStore } from '../store.js';

const REPO = resolve(import.meta.dirname, '../../../../../');
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface ClusterAccessFrom {
  role: PlatformRole;
  clusters?: Pick<InfrastructureStore, 'getClusters'> | undefined;
  dataKey?: SecretKey | undefined;
}

export function clusterAccessFrom(env: Readonly<Record<string, string | undefined>>, from: ClusterAccessFrom): ClusterAccess {
  const folder = join(tmpdir(), `koala-clusters-${process.pid}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const root = from.role === 'root';
  return new ClusterAccess({
    here: { koalaMachineId: env.INSTANCE_MACHINE_ID?.trim() || undefined, root },
    folder,
    processes: nodeProcesses,
    streams: nodeStreams,
    tools: { kubectl: join(REPO, 'bin', 'kubectl'), helm: join(REPO, 'bin', 'helm') },
    clusters: from.clusters,
    dataKey: from.dataKey,
    serviceAccount: serviceAccountFrom(env, SERVICE_ACCOUNT),
    rootKubeconfig: root ? env.POOL_KUBECONFIG?.trim() || undefined : undefined,
  });
}
