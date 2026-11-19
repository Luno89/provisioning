import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeProcesses, nodeStreams } from '../../platform/index.js';
import { startedMachine, type Reach } from '../lib/cluster-places.js';
import { ClusterAccess } from '../services/ClusterAccess.js';
import { chartFolder, chartSourcesStandIn, type ChartSourcesStandIn } from './chart-sources-stand-in.js';
import { startK3s } from './real-k3s.js';
import { CLUSTER_TOOL_PATHS } from '../services/ClusterAccess.js';

export interface WidgetCluster {
  access: ClusterAccess;
  reach: Reach;
  sources: ChartSourcesStandIn;
  crd: string;
  publish(chart: string, version: string, fields: readonly string[], repository?: string): void;
  fields(): Promise<string[]>;
  stop(): Promise<void>;
}

export async function widgetCluster(machine: string, helm: { readsSources: boolean }): Promise<WidgetCluster> {
  const group = `koala${randomBytes(4).toString('hex')}.test`;
  const crd = `widgets.${group}`;
  const definition = (fields: readonly string[]) => `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: ${crd}
spec:
  group: ${group}
  names: { kind: Widget, plural: widgets, singular: widget }
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
${fields.map((field) => `                ${field}: { type: string }`).join('\n')}
`;
  const sources = await chartSourcesStandIn();
  const k3s = await startK3s();
  const access = new ClusterAccess({
    here: { koalaMachineId: 'dev1', root: false },
    folder: mkdtempSync(join(tmpdir(), `koala-${machine}-`)),
    processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: k3s.account,
    ...(helm.readsSources ? { chartSources: sources.url } : {}),
  });
  const reach = startedMachine(machine, k3s.admin);
  return {
    access, reach, sources, crd,
    publish: (chart, version, fields, repository) => sources.publish(chartFolder({
      'Chart.yaml': `apiVersion: v2\nname: ${chart}\nversion: ${version}\n`,
      'crds/widget.yaml': definition(fields),
    }), repository),
    fields: async () => Object.keys(JSON.parse(await access.kubectl(reach, ['get', 'crd', crd, '-o', 'jsonpath={.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties}'])) as object).sort(),
    stop: async () => {
      await sources.close();
      await k3s.stop();
    },
  };
}
