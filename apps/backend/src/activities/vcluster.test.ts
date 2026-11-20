import { mkdtempSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterAccess } from '../infrastructure/index.js';
import { installVcluster, VCLUSTER_CHART_FILE, VCLUSTER_CHART_SHA256 } from './vcluster.js';

const NODE = 'root';
const PLACE = { name: 'ann', namespace: 'pool-ann', values: {} };

describe('the vcluster chart Koala installs', () => {
  it('installs from the copy kept in its folder without fetching it again', async () => {
    const access = mock<ClusterAccess>();
    access.helm.mockResolvedValue('');
    access.kubectl.mockResolvedValue('secret/vc-ann');
    const charts = mkdtempSync(join(tmpdir(), 'koala-charts-'));
    writeFileSync(join(charts, VCLUSTER_CHART_FILE), 'kept');
    await installVcluster(access, NODE, charts, PLACE, async () => undefined);
    expect(access.helm.mock.calls.map(([, args]) => args.slice(0, 4))).toEqual([['upgrade', '--install', 'ann', join(charts, VCLUSTER_CHART_FILE)]]);
  });

  it('refuses a fetched chart whose digest is not the pinned one, installing and keeping nothing', async () => {
    const access = mock<ClusterAccess>();
    access.helm.mockImplementation(async (_at, args) => {
      if (args[0] === 'pull') writeFileSync(join(args[args.indexOf('--destination') + 1]!, VCLUSTER_CHART_FILE), 'not the chart');
      return '';
    });
    const charts = mkdtempSync(join(tmpdir(), 'koala-charts-'));
    await expect(installVcluster(access, NODE, charts, PLACE, async () => undefined)).rejects.toThrow(`not the pinned ${VCLUSTER_CHART_SHA256}, so it was not installed`);
    expect(access.helm.mock.calls.map(([, args]) => args[0])).toEqual(['pull']);
    expect(readdirSync(charts)).toEqual([]);
  });
});
