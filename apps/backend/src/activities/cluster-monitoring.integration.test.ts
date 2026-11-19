import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { InfrastructureService } from '../infrastructure/index.js';
import { widgetCluster, type WidgetCluster } from '../infrastructure/testing/widget-charts.js';
import { MONITORING_CHARTS } from '../monitoring/index.js';
import { installClusterMonitoring } from './cluster-monitoring.js';

const OLDER = '1.0.0';

let cluster: WidgetCluster;

beforeAll(async () => {
  cluster = await widgetCluster(import.meta.filename, 'machine-desk', { readsSources: true });
  cluster.publish(MONITORING_CHARTS.stack.chart, OLDER, ['size'], MONITORING_CHARTS.repo);
  cluster.publish(MONITORING_CHARTS.stack.chart, MONITORING_CHARTS.stack.version, ['size', 'colour'], MONITORING_CHARTS.repo);
}, 0);

afterAll(async () => {
  await cluster?.stop();
}, 0);

describe('a cluster whose monitoring stack is at another version than Koala\'s', () => {
  it('has the CRDs of Koala\'s version applied before the stack is upgraded, read from the chart repository it is told to use', async () => {
    const { access, reach, fields } = cluster;
    await access.helm(reach, ['install', MONITORING_CHARTS.stack.release, MONITORING_CHARTS.stack.chart, '--repo', MONITORING_CHARTS.repo, '--version', OLDER, '-n', MONITORING_CHARTS.namespace, '--create-namespace']);
    expect(await fields()).toEqual(['size']);
    const infra = mock<InfrastructureService>();
    const seenWhenUpgraded: string[][] = [];
    infra.deploy.mockImplementation(async () => { seenWhenUpgraded.push(await fields()); return { stdout: '', logFile: '' }; });

    await installClusterMonitoring({ access, infra }, { physicalName: 'machine-desk', reach });

    expect(infra.deploy).toHaveBeenCalled();
    expect(seenWhenUpgraded[0]).toEqual(['colour', 'size']);
  });
});
