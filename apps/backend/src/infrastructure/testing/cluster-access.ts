import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeProcesses, nodeStreams, type Database, type Processes, type SecretKey, type Streams } from '../../platform/index.js';
import type { ServiceAccount } from '../lib/cluster-places.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess } from '../services/ClusterAccess.js';

export interface TestClusterAccess {
  dataKey?: SecretKey | undefined;
  koalaMachineId?: string | undefined;
  poolName?: string | undefined;
  root?: boolean | undefined;
  serviceAccount?: ServiceAccount | undefined;
  folder?: string | undefined;
  processes?: Processes | undefined;
  streams?: Streams | undefined;
  answers?: ((args: readonly string[]) => Promise<string>) | undefined;
}

const answering = (answers: (args: readonly string[]) => Promise<string>): Processes => ({
  run: async (run) => {
    try {
      return { code: 0, stdout: await answers(run.args.slice(2)), stderr: '' };
    } catch (failure) {
      return { code: 1, stdout: '', stderr: (failure as Error).message };
    }
  },
});

export const testClusterAccess = (db: Pick<Database, 'infrastructure'>, options: TestClusterAccess = {}): ClusterAccess => new ClusterAccess({
  here: { koalaMachineId: options.koalaMachineId, poolName: options.poolName, root: options.root ?? false },
  folder: options.folder ?? mkdtempSync(join(tmpdir(), 'koala-test-clusters-')),
  processes: options.processes ?? (options.answers ? answering(options.answers) : nodeProcesses),
  streams: options.streams ?? nodeStreams,
  tools: CLUSTER_TOOL_PATHS,
  clusters: db.infrastructure,
  dataKey: options.dataKey,
  serviceAccount: options.serviceAccount,
});
