import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { waiting, waitUntil } from '@koala/provision';
import { METRICS_CLIENT_SECRET, metricsClientManifest } from '@koala/engine-core/root-client';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { CLUSTER_TOOL_PATHS, ClusterAccess, InfrastructureService, startedMachine, terraformPlacesFor, type Reach } from '../infrastructure/index.js';
import { privateCluster, type PrivateCluster } from '../infrastructure/testing/private-cluster.js';
import { testDataDir } from '../platform/testing/data-dir.js';
import { koalaClusterMonitoring } from '../monitoring/index.js';
import { installClusterMonitoring } from './cluster-monitoring.js';
import { quickly } from './testing/platform-cluster.js';

const STAND_IN = 'root-stand-in';
const RESOURCE = 'urn:koala:instance:inst-1';
const NEVER_RUNS = new Set(['ImagePullBackOff', 'ErrImagePull', 'CrashLoopBackOff', 'CreateContainerConfigError', 'InvalidImageName']);

const SERVING = `
import base64, json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs
basic = 'Basic ' + base64.b64encode((os.environ['CLIENT_ID'] + ':' + os.environ['CLIENT_SECRET']).encode()).decode()
seen = []
class Answer(BaseHTTPRequestHandler):
    def reply(self, code, value):
        data = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        if self.path == '/token':
            form = parse_qs(body.decode())
            if self.headers.get('Authorization') != basic or form.get('grant_type') != ['client_credentials']:
                seen.append({'refused': 'token'})
                return self.reply(401, {'error': 'invalid_client'})
            return self.reply(200, {'access_token': 'issued-for-' + form.get('resource', [''])[0] + '-' + ' '.join(form.get('scope', [])), 'token_type': 'Bearer', 'expires_in': 300})
        if self.path == '/write':
            seen.append({'authorization': self.headers.get('Authorization'), 'bytes': len(body)})
            self.send_response(204)
            self.end_headers()
            return
        self.reply(404, {})
    def do_GET(self):
        self.reply(200, seen)
ThreadingHTTPServer(('', 8080), Answer).serve_forever()
`;

interface Seen { authorization?: string; bytes?: number; refused?: string }

async function onFreshCluster(file: string, run: (cluster: { k3s: PrivateCluster; access: ClusterAccess; reach: Reach; infra: InfrastructureService }) => Promise<void>): Promise<void> {
  const k3s = await privateCluster(file);
  try {
    const access = new ClusterAccess({
      here: { koalaMachineId: 'desk', root: false },
      folder: mkdtempSync(join(tmpdir(), 'koala-monitoring-')),
      processes: nodeProcesses, streams: nodeStreams, tools: CLUSTER_TOOL_PATHS, serviceAccount: k3s.account,
    });
    const dataDir = testDataDir();
    mkdirSync(dataDir, { recursive: true });
    await run({ k3s, access, reach: startedMachine('machine-desk', k3s.admin), infra: new InfrastructureService(terraformPlacesFor({ kind: 'local' }, dataDir)) });
  } finally {
    await k3s.stop();
  }
}

const agentPutsItsSecret = async (access: ClusterAccess, reach: Reach, client: { clientId: string; clientSecret: string }) => {
  await access.apply(reach, metricsClientManifest(client));
};

const seenBy = async (access: ClusterAccess, reach: Reach): Promise<Seen[]> =>
  JSON.parse(await access.kubectl(reach, ['exec', '-n', STAND_IN, 'root', '--', 'python3', '-c', 'import urllib.request; print(urllib.request.urlopen("http://localhost:8080/seen").read().decode())'])) as Seen[];

async function prometheusHopeless(access: ClusterAccess, reach: Reach): Promise<string | undefined> {
  const pods = JSON.parse(await access.kubectl(reach, ['get', 'pods', '-n', 'monitoring', '-o', 'json'])) as { items: { metadata: { name: string }; status?: { containerStatuses?: { state?: { waiting?: { reason?: string; message?: string } } }[] } }[] };
  for (const pod of pods.items) {
    for (const status of pod.status?.containerStatuses ?? []) {
      const reason = status.state?.waiting?.reason;
      if (reason && NEVER_RUNS.has(reason)) return `${pod.metadata.name} can never run: ${reason} ${status.state?.waiting?.message ?? ''}`;
    }
  }
  return undefined;
}

describe('monitoring set up on a cluster where the machine\'s agent put its Secret first', () => {
  it('a machine\'s monitoring takes over the namespace and its Prometheus remote-writes with a token it took from root with that Secret', async () => {
    await onFreshCluster(import.meta.filename, async ({ access, reach, infra }) => {
      const client = { clientId: 'metrics.desk', clientSecret: randomBytes(16).toString('hex') };
      await access.kubectl(reach, ['create', 'namespace', STAND_IN]);
      await access.apply(reach, JSON.stringify({
        apiVersion: 'v1', kind: 'Pod', metadata: { name: 'root', namespace: STAND_IN, labels: { app: 'root' } },
        spec: { containers: [{ name: 'root', image: 'python:3.12-slim', command: ['python3', '-c', SERVING], env: [{ name: 'CLIENT_ID', value: client.clientId }, { name: 'CLIENT_SECRET', value: client.clientSecret }], ports: [{ containerPort: 8080 }], readinessProbe: { tcpSocket: { port: 8080 } } }] },
      }));
      await access.apply(reach, JSON.stringify({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'root', namespace: STAND_IN }, spec: { selector: { app: 'root' }, ports: [{ port: 8080 }] } }));
      await access.kubectl(reach, ['wait', '-n', STAND_IN, '--for=condition=Ready', 'pod/root', '--timeout=720h']);
      await agentPutsItsSecret(access, reach, client);
      const at = `http://root.${STAND_IN}.svc.cluster.local:8080`;

      await installClusterMonitoring({ access, infra }, { physicalName: 'machine-desk', reach, pool: false, machine: { url: `${at}/write`, tokenUrl: `${at}/token`, resource: RESOURCE } }, {}, quickly);

      const written = await waitUntil('the machine\'s Prometheus to remote-write to its Koala', async () => {
        const seen = await seenBy(access, reach);
        const write = seen.find((each) => each.authorization);
        return write ?? waiting(`it has written ${seen.length} times`);
      }, async () => {
        const seen = await seenBy(access, reach);
        if (seen.some((each) => each.refused)) return 'root refused the token request its Prometheus made with the Secret';
        return prometheusHopeless(access, reach);
      });
      expect(written.authorization).toBe(`Bearer issued-for-${RESOURCE}-koala:metrics`);
      expect(written.bytes).toBeGreaterThan(0);
      expect(await access.kubectl(reach, ['get', 'secret', METRICS_CLIENT_SECRET.name, '-n', METRICS_CLIENT_SECRET.namespace, '-o', 'jsonpath={.metadata.name}'])).toBe(METRICS_CLIENT_SECRET.name);
    });
  }, 0);

  it('Koala\'s own monitoring, on the machine Koala runs on, takes over the namespace, rolls its cluster stack out and keeps the agent\'s Secret in it', async () => {
    await onFreshCluster(`${import.meta.filename}-koala`, async ({ access, reach, infra }) => {
      const client = { clientId: 'metrics.desk', clientSecret: randomBytes(16).toString('hex') };
      await agentPutsItsSecret(access, reach, client);
      const kept = await access.kubectl(reach, ['get', 'secret', METRICS_CLIENT_SECRET.name, '-n', METRICS_CLIENT_SECRET.namespace, '-o', 'jsonpath={.metadata.uid}']);
      const applies = infra.deploy.bind(infra);
      const observability = new Error('the observability stack is left out: promtail in a vcluster finds no logs under the host\'s pod folders, so it never becomes ready there');
      infra.deploy = async (stack, options) => {
        if (stack.endsWith('-observability')) throw observability;
        return applies(stack, options);
      };

      await expect(installClusterMonitoring({ access, infra }, koalaClusterMonitoring(false, reach), {}, quickly)).rejects.toBe(observability);

      expect(await access.kubectl(reach, ['get', 'secret', METRICS_CLIENT_SECRET.name, '-n', METRICS_CLIENT_SECRET.namespace, '-o', 'jsonpath={.metadata.uid}'])).toBe(kept);
      expect(await access.kubectl(reach, ['get', 'statefulsets', '-n', 'monitoring', '-l', 'app.kubernetes.io/name=prometheus', '-o', 'jsonpath={.items[0].status.readyReplicas}'])).toBe('1');
    });
  }, 0);
});
