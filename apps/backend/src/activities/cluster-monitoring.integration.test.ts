import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { ClusterAccess, startedMachine, type InfrastructureService, type Reach } from '../infrastructure/index.js';
import { startK3s, TOOLS, type RealK3s } from '../infrastructure/testing/real-k3s.js';
import { MONITORING_CHARTS } from '../monitoring/index.js';
import { installClusterMonitoring } from './cluster-monitoring.js';

const GROUP = `koala${randomBytes(4).toString('hex')}.test`;
const CRD = `widgets.${GROUP}`;
const PINNED_REPO = MONITORING_CHARTS.repo.replace(/^https:\/\//, '');
const OLDER = '1.0.0';

const crd = (fields: string[]) => `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: ${CRD}
spec:
  group: ${GROUP}
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

let k3s: RealK3s;
let access: ClusterAccess;
let reach: Reach;
let server: Server;
const served = mkdtempSync(join(tmpdir(), 'koala-chart-sources-'));
const repoDir = join(served, PINNED_REPO);

function publish(version: string, fields: string[], base: string): void {
  const chart = mkdtempSync(join(tmpdir(), 'koala-stand-in-chart-'));
  mkdirSync(join(chart, 'crds'));
  writeFileSync(join(chart, 'Chart.yaml'), `apiVersion: v2\nname: ${MONITORING_CHARTS.stack.chart}\nversion: ${version}\n`);
  writeFileSync(join(chart, 'crds', 'widget.yaml'), crd(fields));
  execFileSync(TOOLS.helm, ['package', chart, '--destination', repoDir]);
  execFileSync(TOOLS.helm, ['repo', 'index', repoDir, '--url', `${base}/${PINNED_REPO}`]);
}

beforeAll(async () => {
  mkdirSync(repoDir, { recursive: true });
  server = createServer((req, res) => {
    readFile(join(served, decodeURIComponent((req.url ?? '/').slice(1)))).then((body) => res.end(body), () => { res.statusCode = 404; res.end(); });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const sources = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  publish(OLDER, ['size'], sources);
  publish(MONITORING_CHARTS.stack.version, ['size', 'colour'], sources);
  k3s = await startK3s();
  access = new ClusterAccess({
    here: { koalaMachineId: 'dev1', root: false },
    folder: mkdtempSync(join(tmpdir(), 'koala-cluster-monitoring-')),
    processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, serviceAccount: k3s.account, chartSources: sources,
  });
  reach = startedMachine('machine-desk', k3s.admin);
}, 0);

afterAll(async () => {
  await new Promise((closed) => server?.close(closed));
  await k3s?.stop();
}, 0);

const fields = async () => Object.keys(JSON.parse(await access.kubectl(reach, ['get', 'crd', CRD, '-o', 'jsonpath={.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties}'])) as object).sort();

describe('a cluster whose monitoring stack is at another version than Koala\'s', () => {
  it('has the CRDs of Koala\'s version applied before the stack is upgraded, read from the chart repository it is told to use', async () => {
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
