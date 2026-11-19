import { mkdtempSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateClusterFileOf, takePrivateCluster } from './private-clusters.js';

const SHARED = { admin: '', account: { host: '127.0.0.1', port: '1', caFile: '/none', tokenFile: '/none' } };

describe('a file asking for the cluster the run started for it', () => {
  it('fails, saying why, once the run says its cluster did not come up', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'koala-private-clusters-'));
    const asked = takePrivateCluster(SHARED, folder, 'src/pool/broken.integration.test.ts');
    await writeFile(join(folder, 'landing'), 'helm said the namespace is full');
    await rename(join(folder, 'landing'), join(folder, 'src_pool_broken.integration.test.ts.failed'));
    await expect(asked).rejects.toThrow('the cluster started for src/pool/broken.integration.test.ts at the run\'s start did not come up: helm said the namespace is full');
  });

  it('is refused when the file is not among those the run starts clusters for, saying where to add it', () => {
    expect(() => privateClusterFileOf('/repo/apps/backend/src/elsewhere.integration.test.ts')).toThrow('is not in PRIVATE_CLUSTER_FILES');
    expect(privateClusterFileOf('/repo/apps/backend/src/activities/cluster-steps.integration.test.ts')).toBe('src/activities/cluster-steps.integration.test.ts');
  });
});
