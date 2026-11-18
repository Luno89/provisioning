import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ApplicationFailure } from '@temporalio/common';
import type { ClusterAccess, Target } from '../infrastructure/index.js';
import {
  admissionManifests, backendAccessManifest, INSTANCE_RELEASE, namespaceManifest, POOL_LABEL, poolNamespace, PROXY, proxyCaddyfile,
  proxyManifests, RUNTIME_CLASS, VCLUSTER_CHART_VERSION, vclusterAddress, vclusterValues, type PoolSettings,
} from '../instances/index.js';
import { applyChartCrds } from './chart-crds.js';
import { BLACKBOX_VALUES, POOL_MONITORING, poolAppAlerts, poolStackValues, probeIngressPolicy } from '../monitoring/index.js';
import { messageOf, waitingOn } from './failure-reasons.js';

export const ADMISSION_CHECK_NAMESPACE = 'pool-admission-check';

export type PoolNodeAccess = Pick<ClusterAccess, 'kubectl' | 'helm' | 'apply'>;

export interface PoolNodeDeps {
  access: PoolNodeAccess;
  node: Target;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export const yaml = (docs: Record<string, unknown>[]): string => docs.map((doc) => JSON.stringify(doc)).join('\n---\n');

export function installJob(job: string, namespace: string, vcluster: string, image: PoolSettings['image']): Record<string, unknown> {
  const script = [
    'set -eu',
    `sed "s|server: .*|server: https://${vclusterAddress(vcluster)}:443|" /vc/config > /tmp/kubeconfig`,
    'chmod 600 /tmp/kubeconfig',
    `exec entrypoint install-koala --kubeconfig /tmp/kubeconfig --release ${INSTANCE_RELEASE.name} --namespace ${INSTANCE_RELEASE.namespace} --chart /app/charts/instance -- -f /values/values.json`,
  ].join('\n');
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: job, namespace },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        spec: {
          runtimeClassName: RUNTIME_CLASS,
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          containers: [{
            name: 'install',
            image: `${image.repository}:${image.tag}`,
            command: ['sh', '-c', script],
            resources: { requests: { memory: '128Mi', cpu: '50m' }, limits: { memory: '512Mi' } },
            volumeMounts: [{ name: 'vc', mountPath: '/vc', readOnly: true }, { name: 'values', mountPath: '/values', readOnly: true }],
          }],
          volumes: [
            { name: 'vc', secret: { secretName: `vc-${vcluster}` } },
            { name: 'values', secret: { secretName: 'instance-values' } },
          ],
        },
      },
    },
  };
}

export class PoolNode {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: PoolNodeDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private kubectl(args: string[]): Promise<string> {
    return this.deps.access.kubectl(this.deps.node, args);
  }

  private helm(args: string[]): Promise<string> {
    return this.deps.access.helm(this.deps.node, args);
  }

  private apply(docs: Record<string, unknown>[]): Promise<string> {
    return this.deps.access.apply(this.deps.node, yaml(docs));
  }

  async ready(pool: Pick<PoolSettings, 'image' | 'address'>, rootCaddies: () => Promise<string[]>): Promise<void> {
    const classes = await this.kubectl(['get', 'runtimeclass', '-o', 'name']);
    if (!classes.split('\n').includes(`runtimeclass.node.k8s.io/${RUNTIME_CLASS}`)) {
      throw ApplicationFailure.nonRetryable('the pool\'s node has no gVisor runtime yet: run scripts/root-node/gvisor.sh on it first', 'NoGvisor');
    }
    await this.apply([...admissionManifests(pool.image.repository), {
      apiVersion: 'v1', kind: 'Namespace', metadata: { name: ADMISSION_CHECK_NAMESPACE, labels: { [POOL_LABEL]: 'true', 'pod-security.kubernetes.io/enforce': 'baseline' } },
    }]);
    for (;;) {
      const refused = await this.kubectl(['run', 'admission-check', '-n', ADMISSION_CHECK_NAMESPACE, '--image=busybox:1.37', '--restart=Never', '--dry-run=server', '-o', 'name'])
        .then(() => false, (error: Error) => error.message.includes('runs under gVisor'));
      if (refused) break;
      await this.sleep(2000);
    }
    const existing = await this.kubectl(['get', 'daemonset', PROXY.name, '-n', PROXY.namespace, '--ignore-not-found', '-o', 'name']);
    if (!existing.trim()) await this.apply(proxyManifests(proxyCaddyfile([], pool.address, await rootCaddies())));
    await this.monitoring();
  }

  private async deployedVersion(release: string): Promise<string | undefined> {
    const listed = JSON.parse(await this.helm(['list', '-n', POOL_MONITORING.namespace, '--filter', `^${release}$`, '-o', 'json'])) as Array<{ chart?: string; status?: string }>;
    const found = listed[0];
    return found?.status === 'deployed' ? found.chart : undefined;
  }

  private async monitoring(): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-monitoring-'));
    try {
      const stack = POOL_MONITORING.stack;
      if (await this.deployedVersion(stack.release) !== `${stack.chart}-${stack.version}`) {
        await applyChartCrds(this.deps.access, this.deps.node, stack, POOL_MONITORING.repo);
        const values = path.join(dir, 'stack.json');
        await fs.writeFile(values, JSON.stringify(poolStackValues()));
        await this.helm(['upgrade', '--install', stack.release, stack.chart, '--repo', POOL_MONITORING.repo, '--version', stack.version,
          '-n', POOL_MONITORING.namespace, '--create-namespace', '--wait', '--timeout', '720h', '-f', values]);
      }
      const blackbox = POOL_MONITORING.blackbox;
      if (await this.deployedVersion(blackbox.release) !== `${blackbox.chart}-${blackbox.version}`) {
        const values = path.join(dir, 'blackbox.yaml');
        await fs.writeFile(values, BLACKBOX_VALUES);
        await this.helm(['upgrade', '--install', blackbox.release, blackbox.chart, '--repo', POOL_MONITORING.repo, '--version', blackbox.version,
          '-n', POOL_MONITORING.namespace, '--wait', '--timeout', '720h', '-f', values]);
      }
      await this.apply([poolAppAlerts()]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async proxy(caddyfile: string): Promise<void> {
    await this.apply([proxyManifests(caddyfile)[0]!]);
  }

  async vcluster(instance: { name: string; ownerId: string; registryPort: number }, slot: PoolSettings['slot']): Promise<void> {
    const { name } = instance;
    const namespace = poolNamespace(name);
    await this.apply([namespaceManifest(name, instance.ownerId, instance.registryPort), backendAccessManifest(name)]);
    await this.apply([probeIngressPolicy(name, { hostNamespace: namespace })]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-'));
    try {
      const values = path.join(dir, 'vcluster.json');
      await fs.writeFile(values, JSON.stringify(vclusterValues(name, slot)));
      await this.helm(['upgrade', '--install', name, 'vcluster', '--repo', 'https://charts.loft.sh', '--version', VCLUSTER_CHART_VERSION,
        '-n', namespace, '--wait', '--timeout', '720h', '-f', values]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    const waiting = waitingOn(`the vcluster ${name}'s sign-in`);
    for (;;) {
      const secret = await this.kubectl(['get', 'secret', `vc-${name}`, '-n', namespace, '-o', 'name']).catch((err: unknown) => { waiting(err); return ''; });
      if (secret.trim()) break;
      await this.sleep(2000);
    }
  }

  async install(name: string, job: string, values: unknown, image: PoolSettings['image']): Promise<void> {
    const namespace = poolNamespace(name);
    await this.apply([
      { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'instance-values', namespace }, stringData: { 'values.json': JSON.stringify(values) } },
      installJob(job, namespace, name, image),
    ]);
    const waiting = waitingOn(`the install job ${job} in ${namespace}`);
    for (;;) {
      const counts = await this.kubectl(['get', 'job', job, '-n', namespace, '-o', 'jsonpath={.status.succeeded}|{.status.failed}']).catch((err: unknown) => { waiting(err); return '|'; });
      const [succeeded, failed] = counts.split('|');
      if (Number(succeeded) > 0) return;
      if (Number(failed) > 0) {
        const logs = await this.kubectl(['logs', `job/${job}`, '-n', namespace, '--tail=30']).catch((err: unknown) => `its log could not be read: ${messageOf(err)}`);
        throw new Error(`installing Koala in ${namespace} failed: ${logs.trim().split('\n').slice(-6).join(' | ') || 'no log'}`);
      }
      await this.sleep(5000);
    }
  }

  async backendAnswers(address: string, port: number, what: string): Promise<void> {
    const probe = `wget -q -O /dev/null -T 10 http://${address}:${port}/api/auth/sign-in`;
    const waiting = waitingOn(what);
    for (;;) {
      const answered = await this.kubectl(['exec', '-n', PROXY.namespace, `daemonset/${PROXY.name}`, '--', 'sh', '-c', probe]).then(() => true, (err: unknown) => { waiting(err); return false; });
      if (answered) return;
      await this.sleep(5000);
    }
  }

  async replicas(name: string, replicas: 0 | 1): Promise<void> {
    const namespace = poolNamespace(name);
    await this.kubectl(['scale', 'statefulset', name, '-n', namespace, `--replicas=${replicas}`]);
    if (replicas === 0) {
      await this.kubectl(['delete', 'pods', '-n', namespace, '-l', `vcluster.loft.sh/managed-by=${name}`, '--wait=true']);
    }
  }

  async remove(name: string): Promise<void> {
    const namespace = poolNamespace(name);
    await this.helm(['uninstall', name, '-n', namespace, '--ignore-not-found', '--wait', '--timeout', '720h']);
    await this.kubectl(['delete', 'namespace', namespace, '--ignore-not-found', '--wait=true']);
  }
}
