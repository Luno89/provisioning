import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { ClusterAccess, startedMachine, type Reach } from '../infrastructure/index.js';
import { startK3s, TOOLS, type RealK3s } from '../infrastructure/testing/real-k3s.js';
import { applyChartCrds } from './chart-crds.js';

const GROUP = `koala${randomBytes(4).toString('hex')}.test`;
const CRD = `widgets.${GROUP}`;

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
let repo: string;
const served = mkdtempSync(join(tmpdir(), 'koala-chart-repo-'));

function publish(version: string, fields: string[]): void {
  const chart = mkdtempSync(join(tmpdir(), 'koala-chart-'));
  mkdirSync(join(chart, 'crds'));
  writeFileSync(join(chart, 'Chart.yaml'), `apiVersion: v2\nname: widgets\nversion: ${version}\n`);
  writeFileSync(join(chart, 'crds', 'widget.yaml'), crd(fields));
  execFileSync(TOOLS.helm, ['package', chart, '--destination', served]);
  execFileSync(TOOLS.helm, ['repo', 'index', served, '--url', repo]);
}

beforeAll(async () => {
  k3s = await startK3s();
  access = new ClusterAccess({
    here: { koalaMachineId: 'dev1', root: false },
    folder: mkdtempSync(join(tmpdir(), 'koala-chart-crds-')),
    processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, serviceAccount: k3s.account,
  });
  reach = startedMachine('machine-crds', k3s.admin);
  server = createServer((req, res) => {
    readFile(join(served, (req.url ?? '/').slice(1))).then((body) => res.end(body), () => { res.statusCode = 404; res.end(); });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  repo = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 0);

afterAll(async () => {
  await new Promise((closed) => server?.close(closed));
  await k3s?.stop();
}, 0);

const fields = async () => Object.keys(JSON.parse(await access.kubectl(reach, ['get', 'crd', CRD, '-o', 'jsonpath={.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties}'])) as object).sort();

describe('the CRDs of a chart, applied before the chart is upgraded', () => {
  it('applies the CRDs the chart version carries, server side, and a later version\'s over them', async () => {
    publish('1.0.0', ['size']);
    await applyChartCrds(access, reach, { chart: 'widgets', version: '1.0.0' }, repo);
    expect(await fields()).toEqual(['size']);
    expect(await access.kubectl(reach, ['get', 'crd', CRD, '-o', 'jsonpath={.metadata.managedFields[*].operation}'])).toContain('Apply');

    publish('2.0.0', ['size', 'colour']);
    await applyChartCrds(access, reach, { chart: 'widgets', version: '2.0.0' }, repo);
    expect(await fields()).toEqual(['colour', 'size']);
  });
});
