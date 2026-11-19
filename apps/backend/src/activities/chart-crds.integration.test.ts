import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { widgetCluster, type WidgetCluster } from '../infrastructure/testing/widget-charts.js';
import { applyChartCrds } from './chart-crds.js';

let cluster: WidgetCluster;

beforeAll(async () => {
  cluster = await widgetCluster(import.meta.filename, 'machine-crds', { readsSources: false });
}, 0);

afterAll(async () => {
  await cluster?.stop();
}, 0);

describe('the CRDs of a chart, applied before the chart is upgraded', () => {
  it('applies the CRDs the chart version carries, server side, and a later version\'s over them', async () => {
    const { access, reach, sources, crd, publish, fields } = cluster;
    publish('widgets', '1.0.0', ['size']);
    await applyChartCrds(access, reach, { chart: 'widgets', version: '1.0.0' }, sources.url);
    expect(await fields()).toEqual(['size']);
    expect(await access.kubectl(reach, ['get', 'crd', crd, '-o', 'jsonpath={.metadata.managedFields[*].operation}'])).toContain('Apply');

    publish('widgets', '2.0.0', ['size', 'colour']);
    await applyChartCrds(access, reach, { chart: 'widgets', version: '2.0.0' }, sources.url);
    expect(await fields()).toEqual(['colour', 'size']);
  });
});
