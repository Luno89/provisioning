import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeProcesses, nodeStreams, type Database, type Processes, type SecretKey, type Streams } from '../../platform/index.js';
import type { ServiceAccount } from '../lib/cluster-places.js';
import { ClusterAccess } from '../services/ClusterAccess.js';

export interface TestClusterAccess {
  dataKey?: SecretKey | undefined;
  koalaMachineId?: string | undefined;
  serviceAccount?: ServiceAccount | undefined;
  folder?: string | undefined;
  processes?: Processes | undefined;
  streams?: Streams | undefined;
}

export const testClusterAccess = (db: Pick<Database, 'infrastructure'>, options: TestClusterAccess = {}): ClusterAccess => new ClusterAccess({
  here: { koalaMachineId: options.koalaMachineId, root: false },
  folder: options.folder ?? mkdtempSync(join(tmpdir(), 'koala-test-clusters-')),
  processes: options.processes ?? nodeProcesses,
  streams: options.streams ?? nodeStreams,
  tools: { kubectl: 'kubectl', helm: 'helm' },
  clusters: db.infrastructure,
  dataKey: options.dataKey,
  serviceAccount: options.serviceAccount,
});
