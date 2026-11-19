import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../../platform/index.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess } from '../services/ClusterAccess.js';
import { namespacesOf } from './cluster-wide.js';
import { controlPlaneGone, startPrivateClusters, takePrivateCluster, TEST_CHARTS } from './private-clusters.js';

const shared = inject('k3s');
const sharedFile = join(mkdtempSync(join(tmpdir(), 'koala-private-clusters-')), 'shared.yaml');
writeFileSync(sharedFile, shared.admin, { mode: 0o600 });

describe('the clusters a run starts for the files that ask for one', () => {
  it('hands a file the cluster started for it at the run\'s start, and removes the ones nobody took', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'koala-private-clusters-run-'));
    const clusters = await startPrivateClusters(shared, ['src/pool/taken.integration.test.ts', 'src/pool/left.integration.test.ts'], folder, TEST_CHARTS);

    const taken = await takePrivateCluster(shared, folder, 'src/pool/taken.integration.test.ts');
    const access = new ClusterAccess({ here: { koalaMachineId: 'desk', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-private-clusters-access-')), processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: taken.account });
    await access.kubectl(access.own(), ['create', 'namespace', 'taken-here']);
    expect(taken.namespace).toMatch(/^vc-taken-[0-9a-f]{8}$/);
    expect(await namespacesOf(sharedFile)).not.toContain('taken-here');
    const onShared = new ClusterAccess({ here: { koalaMachineId: 'desk', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-private-clusters-shared-')), processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: shared.account });
    expect(await controlPlaneGone(onShared, taken.namespace)).toBeUndefined();

    await clusters.removeUntaken();

    const left = await namespacesOf(sharedFile);
    expect(left).toContain(taken.namespace);
    expect(left.filter((name) => name.startsWith('vc-left-'))).toEqual([]);

    await taken.stop();
    expect(await namespacesOf(sharedFile)).not.toContain(taken.namespace);
    expect(await controlPlaneGone(onShared, taken.namespace)).toBe('its control plane is gone');
  }, 0);
});
