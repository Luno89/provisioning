import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess } from '../infrastructure/index.js';
import { kubectlOn } from './move-import.js';

describe('the move on the new machine reaching its own cluster', () => {
  const own = { clusterId: 'machine-desk', kind: 'koala' } as const;

  it('asks kubectl on the cluster it runs in', async () => {
    const access = mock<ClusterAccess>();
    access.own.mockReturnValue(own);
    access.kubectl.mockResolvedValue('pod/gitea-0\n');
    expect(await kubectlOn(access)(['get', 'pods'])).toBe('pod/gitea-0\n');
    expect(access.kubectl).toHaveBeenCalledWith(own, ['get', 'pods']);
    expect(access.pipe).not.toHaveBeenCalled();
  });

  it('pipes what root carried into kubectl on the cluster it runs in', async () => {
    const access = mock<ClusterAccess>();
    access.own.mockReturnValue(own);
    access.pipe.mockResolvedValue('restored');
    const carried = Readable.from(['dump']);
    expect(await kubectlOn(access)(['exec', '-i', 'pg', '--', 'psql'], carried)).toBe('restored');
    expect(access.pipe).toHaveBeenCalledWith(own, ['exec', '-i', 'pg', '--', 'psql'], carried);
    expect(access.kubectl).not.toHaveBeenCalled();
  });
});
