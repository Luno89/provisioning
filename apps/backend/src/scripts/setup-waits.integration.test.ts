import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { nodeProcesses, nodeStreams } from '../platform/index.js';
import { mongoTarget } from '../platform/lib/mongo-target.js';
import { ClusterAccess } from '../infrastructure/services/ClusterAccess.js';
import { TOOLS } from '../infrastructure/testing/real-k3s.js';
import { testNamespaces } from '../infrastructure/testing/test-namespaces.js';
import { setupWaitsOn } from './setup-waits.js';

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
    const waiting = setupWaitsOn({ step: 'seed', after: ['luno-platform-services-1'], podNamespace: namespace, mongo: mongoTarget({ MONGO_URI: `${inject('mongoUri')}setup_waits` }) }, access, (line) => said.push(line));
    const apply = new ClusterAccess({ here: { root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-setup-waits-apply-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS });
    await apply.apply({ clusterId: 'setup', kind: 'machine', kubeconfig: k3s.admin }, job('luno-platform-services-1', namespace, 'echo set up'));
    await waiting;
    expect(said).toEqual(['[setup] seed waits for the instance\'s Mongo and for luno-platform-services-1', '[setup] seed may run']);
  }, 300_000);

  it('stops, naming the step before it that failed', async () => {
    const namespace = namespaces.name('setup-waits-failed');
    const access = cluster();
    await access.kubectl(['create', 'namespace', namespace]);
    const apply = new ClusterAccess({ here: { root: false }, folder: mkdtempSync(join(tmpdir(), 'koala-setup-waits-apply-')), processes: nodeProcesses, streams: nodeStreams, tools: TOOLS });
    await apply.apply({ clusterId: 'setup', kind: 'machine', kubeconfig: k3s.admin }, job('luno-move-data-1', namespace, 'exit 3'));
    await expect(setupWaitsOn({ step: 'move-restore', after: ['luno-move-data-1'], podNamespace: namespace, mongo: mongoTarget({ MONGO_URI: `${inject('mongoUri')}setup_waits` }) }, access, () => undefined))
      .rejects.toThrow('luno-move-data-1 failed, so move-restore cannot run after it');
  }, 300_000);
});
