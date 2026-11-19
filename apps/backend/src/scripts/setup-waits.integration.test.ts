import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { mongoTarget } from '../platform/lib/mongo-target.js';
import { ClusterAccess } from '../infrastructure/services/ClusterAccess.js';
import { TOOLS } from '../infrastructure/testing/real-k3s.js';
import { testNamespaces } from '../infrastructure/testing/test-namespaces.js';
import { setupWaitsOn, setupWaitsStep } from './setup-waits.js';

const k3s = inject('k3s');
const namespaces = testNamespaces(k3s.admin);
afterAll(async () => { await namespaces.removeAll(); }, 0);

const cluster = () => new ClusterAccess({ here: { root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-setup-waits-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS })
  .chartCluster({ clusterId: 'setup', kind: 'machine', kubeconfig: k3s.admin });

const job = (name: string, namespace: string, script: string) => [
  'apiVersion: batch/v1', 'kind: Job', 'metadata:', `  name: ${name}`, `  namespace: ${namespace}`, 'spec:', '  backoffLimit: 0', '  template:', '    spec:',
  '      restartPolicy: Never', '      terminationGracePeriodSeconds: 0', `      containers: [{ name: step, image: busybox:1.37, command: [sh, -c, ${JSON.stringify(script)}] }]`, '',
].join('\n');

describe('what a setup step waits for, with the instance\'s Mongo and the Jobs on a real k3s', () => {
  it('goes on once Mongo answers and the step before it has finished', async () => {
    const namespace = namespaces.name('setup-waits');
    const access = cluster();
    await access.kubectl(['create', 'namespace', namespace]);
    const said: string[] = [];
    const waiting = setupWaitsOn({ step: 'seed', after: ['luno-move-mongo-1'], podNamespace: namespace, mongo: mongoTarget({ MONGO_URI: `${inject('mongoUri')}setup_waits` }) }, access, (line) => said.push(line));
    const apply = new ClusterAccess({ here: { root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-setup-waits-apply-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS });
    await apply.apply({ clusterId: 'setup', kind: 'machine', kubeconfig: k3s.admin }, job('luno-move-mongo-1', namespace, 'echo set up'));
    await waiting;
    expect(said).toEqual(['[setup] seed waits for the instance\'s Mongo and for luno-move-mongo-1', '[setup] seed may run']);
  }, 300_000);

  it('says now and then what it still waits for, with what it last heard, while the step before it has not been made yet', async () => {
    const namespace = namespaces.name('setup-waits-later');
    const access = cluster();
    await access.kubectl(['create', 'namespace', namespace]);
    const apply = new ClusterAccess({ here: { root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-setup-waits-apply-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS });
    const said: string[] = [];
    let made: Promise<string> | undefined;
    const say = (line: string): void => {
      said.push(line);
      if (!made && line.startsWith('[setup] still waiting for luno-later-1')) made = apply.apply({ clusterId: 'setup', kind: 'machine', kubeconfig: k3s.admin }, job('luno-later-1', namespace, 'echo later'));
    };
    await setupWaitsOn({ step: 'seed', after: ['luno-later-1'], podNamespace: namespace, mongo: mongoTarget({ MONGO_URI: `${inject('mongoUri')}setup_waits` }) }, access, say, { pause: async () => undefined });
    await made;
    const waited = said.filter((line) => line.startsWith('[setup] still waiting for'));
    expect(waited.length).toBeGreaterThan(0);
    expect(waited[0]).toMatch(/^\[setup\] still waiting for luno-later-1 to finish before seed \(.*not found.*\)$/);
    expect(said.at(-1)).toBe('[setup] seed may run');
  }, 0);

  it('stops, naming the step before it that failed', async () => {
    const namespace = namespaces.name('setup-waits-failed');
    const access = cluster();
    await access.kubectl(['create', 'namespace', namespace]);
    const apply = new ClusterAccess({ here: { root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-setup-waits-apply-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS });
    await apply.apply({ clusterId: 'setup', kind: 'machine', kubeconfig: k3s.admin }, job('luno-move-data-1', namespace, 'exit 3'));
    await expect(setupWaitsOn({ step: 'move-mongo', after: ['luno-move-data-1'], podNamespace: namespace, mongo: mongoTarget({ MONGO_URI: `${inject('mongoUri')}setup_waits` }) }, access, () => undefined))
      .rejects.toThrow('luno-move-data-1 failed, so move-mongo cannot run after it');
  }, 300_000);

  it('runs as the instance chart\'s Job runs it, from the settings the chart gives and the pod\'s own account on its cluster', async () => {
    const namespace = namespaces.name('setup-waits-step');
    const access = cluster();
    await access.kubectl(['create', 'namespace', namespace]);
    const apply = new ClusterAccess({ here: { root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-setup-waits-apply-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS });
    await apply.apply({ clusterId: 'setup', kind: 'machine', kubeconfig: k3s.admin }, job('luno-move-data-1', namespace, 'echo copied'));
    const said: string[] = [];
    await setupWaitsStep({
      ROLE: 'instance', INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: 'https://app.koala.dev',
      ROOT_PUBLIC_KEYS: Buffer.from(String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))).toString('base64'),
      INSTANCE_MACHINE_ID: 'desk', SETUP_STEP: 'move-mongo', SETUP_AFTER: 'luno-move-data-1', POD_NAMESPACE: namespace, MONGO_URI: `${inject('mongoUri')}setup_waits`,
      KUBERNETES_SERVICE_HOST: k3s.account.host, KUBERNETES_SERVICE_PORT: k3s.account.port,
    }, (line) => said.push(line), dirname(k3s.account.caFile));
    expect(said).toEqual(['[setup] move-mongo waits for the instance\'s Mongo and for luno-move-data-1', '[setup] move-mongo may run']);
  }, 0);
});
