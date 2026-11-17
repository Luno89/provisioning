import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { encryptValue, nodeProcesses, nodeStreams, succeeded, type ClusterMetadata, type DeploymentMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { adminEdge } from '../../instances/services/InstanceAddresses.js';
import { startK3s, TOOLS } from '../testing/real-k3s.js';
import { AppExposureService } from './AppExposureService.js';
import { ClusterAccess } from './ClusterAccess.js';
import { throwawayLabel } from '@koala/engine-core/testing/throwaway-containers';

const KEY = 'test-key' as never;
const k3s = await startK3s();
const REPO = resolve(import.meta.dirname, '../../../../..');
const EDGE_IMAGE = 'caddy:2.10.2-alpine';
const NAMESPACE = `shop-${randomUUID().slice(0, 6)}`;
const docker = (...args: string[]): Promise<string> => succeeded(nodeProcesses, { command: 'docker', args });

function chartEdgeCaddyfile(): string {
  const rendered = execFileSync(join(REPO, 'bin/helm'), ['template', 'luno', join(REPO, 'charts/instance'), '--set', 'instance.id=i', '--set', 'instance.ownerId=o', '--set', 'instance.rootUrl=https://app.example.com', '--set', 'instance.rootPublicKeys=PEM', '--set', 'instance.credential=c', '--set', 'publicUrl=https://luno.example.com', '--set', 'storage.total=1Gi'], { encoding: 'utf8' });
  const edge = parseAllDocuments(rendered).map((doc) => doc.toJSON() as { kind?: string; metadata?: { name?: string }; data?: Record<string, string> })
    .find((doc) => doc.kind === 'ConfigMap' && doc.metadata?.name === 'luno-edge');
  return edge!.data!.Caddyfile!.replace('admin localhost:2019', 'admin 0.0.0.0:2019');
}

const POD = `apiVersion: v1
kind: Pod
metadata: {name: web, namespace: traefik, labels: {app: web}}
spec:
  containers:
  - name: web
    image: busybox:1.37
    command: [sh, -c, "mkdir /w && echo from-the-app > /w/index.html && httpd -f -p 80 -h /w"]
---
apiVersion: v1
kind: Service
metadata: {name: traefik, namespace: traefik}
spec:
  type: NodePort
  selector: {app: web}
  ports: [{name: web, port: 80, targetPort: 80}]
`;

let edgeName = '';
let sites = '';
let admin = '';
let local = '';

function ask(host: string): Promise<{ status: number; body: string }> {
  return new Promise((done, failed) => {
    const asked = request(`${local}/`, { headers: { host } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => done({ status: response.statusCode ?? 0, body }));
    });
    asked.on('error', failed);
    asked.end();
  });
}

beforeAll(async () => {
  const folder = mkdtempSync(join(tmpdir(), 'koala-edge-'));
  sites = join(folder, 'apps');
  mkdirSync(sites);
  chmodSync(folder, 0o755);
  chmodSync(sites, 0o777);
  writeFileSync(join(folder, 'Caddyfile'), chartEdgeCaddyfile());
  edgeName = `koala-edge-test-${randomUUID().slice(0, 8)}`;
  await docker('run', '-d', '--name', edgeName, ...throwawayLabel(), '-p', '127.0.0.1::2019', '-p', '127.0.0.1::8000',
    '-v', `${join(folder, 'Caddyfile')}:/etc/edge/Caddyfile:ro`, '-v', `${sites}:/app/apps/backend/data/caddy/apps:ro`,
    EDGE_IMAGE, 'caddy', 'run', '--config', '/etc/edge/Caddyfile');
  const port = async (inside: string) => (await docker('port', edgeName, inside)).split('\n')[0]!.split(':').pop()!.trim();
  admin = `http://127.0.0.1:${await port('2019')}`;
  local = `http://127.0.0.1:${await port('8000')}`;
  for (;;) {
    const answered = await fetch(`${admin}/config/`).then((r) => r.ok, () => false);
    if (answered) break;
    await new Promise((done) => setTimeout(done, 200));
  }
}, 120_000);

afterAll(async () => {
  if (edgeName) await docker('rm', '-f', edgeName);
  await k3s.stop();
}, 0);

describe('an app exposed on this computer through the instance\'s real edge', () => {
  it('answers at <app>.localhost through the edge from the chart, reaching the app on the person\'s machine at its mesh address, and stops answering once taken away', async () => {
    const db = await testDatabase();
    const access = new ClusterAccess({ clusters: db.infrastructure, here: { koalaMachineId: 'dev1', root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-expose-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS, dataKey: KEY });
    const machine = { id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'healthy', ownerId: 'bo', createdAt: 't', kubeconfigEnc: encryptValue(k3s.admin, KEY) } as ClusterMetadata;
    await db.infrastructure.saveCluster(machine);
    await access.kubectl('machine-desk', ['create', 'namespace', NAMESPACE]);
    await access.kubectl('machine-desk', ['create', 'service', 'clusterip', 'shop-live', '-n', NAMESPACE, '--tcp=80:80']);
    await access.kubectl('machine-desk', ['create', 'namespace', 'traefik']);
    await access.apply('machine-desk', POD);
    await access.kubectl('machine-desk', ['wait', '--for=condition=Ready', 'pod/web', '-n', 'traefik', '--timeout=720h']);
    const nodeAddress = (await access.kubectl('machine-desk', ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'])).trim();
    const nodePort = (await access.kubectl('machine-desk', ['get', 'service', 'traefik', '-n', 'traefik', '-o', 'jsonpath={.spec.ports[0].nodePort}'])).trim();
    while ((await nodeProcesses.run({ command: 'docker', args: ['exec', edgeName, 'wget', '-q', '-T', '5', '-O', '-', `http://${nodeAddress}:${nodePort}/`] })).stdout !== 'from-the-app\n') {
      const edgeState = (await nodeProcesses.run({ command: 'docker', args: ['inspect', '-f', '{{.State.Status}}', edgeName] })).stdout.trim();
      if (edgeState !== 'running') throw new Error(`the edge ${edgeName} is ${edgeState}`);
      await new Promise((done) => setTimeout(done, 200));
    }
    await db.infrastructure.saveCluster({ ...machine, meshIp: nodeAddress });
    await db.infrastructure.saveDeployment({ id: 'd1abcdef', name: 'Shop', namespace: NAMESPACE, clusterId: 'machine-desk', strategy: 'helm', status: 'running', ownerId: 'bo' } as DeploymentMetadata);

    const edge = adminEdge({ name: undefined, localPort: 8000, sites, adminUrl: admin, caddyfile: join(sites, '..', 'Caddyfile') }, () => undefined);
    const exposure = new AppExposureService(db, { access, getByIdUnscoped: async (id) => (await db.infrastructure.getClusters()).find((c) => c.id === id) }, undefined, { edge });

    expect(await ask('shop.localhost:8000')).toEqual({ status: 404, body: 'No app is exposed at this address on this computer.' });
    const exposed = await exposure.exposeLocal('d1abcdef');
    expect(exposed.localExposureUrl).toBe('http://shop.localhost:8000');
    expect(await ask('shop.localhost:8000')).toEqual({ status: 200, body: 'from-the-app\n' });
    expect((await ask('other.localhost:8000')).status).toBe(404);

    await exposure.syncExposedApps();
    expect(await ask('shop.localhost:8000')).toEqual({ status: 200, body: 'from-the-app\n' });

    await exposure.unexposeLocal('d1abcdef');
    expect(await ask('shop.localhost:8000')).toEqual({ status: 404, body: 'No app is exposed at this address on this computer.' });
  }, 600_000);
});
