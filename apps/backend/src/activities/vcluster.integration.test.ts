import { createHash } from 'crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, inject, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess } from '../infrastructure/index.js';
import { vclusterChart, VCLUSTER_CHART_FILE, VCLUSTER_CHART_SHA256 } from './vcluster.js';

describe('the vcluster chart, fetched from its repository', () => {
  it('is fetched once however many installs ask at once, checked against its pinned digest, and kept in its folder', async () => {
    const access = new ClusterAccess({ here: { koalaMachineId: 'desk', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-vcluster-chart-')), processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: inject('k3s').account });
    const pulls: string[][] = [];
    const counted = { kubectl: access.kubectl.bind(access), helm: async (target: Parameters<ClusterAccess['helm']>[0], args: readonly string[]) => { if (args[0] === 'pull') pulls.push([...args]); return access.helm(target, args); } };
    const charts = mkdtempSync(join(tmpdir(), 'koala-charts-'));
    const node = access.own();

    const asked = await Promise.all([vclusterChart(counted, node, charts), vclusterChart(counted, node, charts), vclusterChart(counted, node, charts)]);
    const again = await vclusterChart(counted, node, charts);

    expect(new Set([...asked, again])).toEqual(new Set([join(charts, VCLUSTER_CHART_FILE)]));
    expect(pulls).toHaveLength(1);
    expect(readdirSync(charts)).toEqual([VCLUSTER_CHART_FILE]);
    expect(createHash('sha256').update(readFileSync(join(charts, VCLUSTER_CHART_FILE))).digest('hex')).toBe(VCLUSTER_CHART_SHA256);
  }, 0);
});
