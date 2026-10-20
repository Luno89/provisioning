import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ApplicationFailure } from '@temporalio/common';
import { createDatabase } from '../lib/db-interface.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { hashCredential } from '../services/InstanceService.js';
import { roleFromEnv } from '../lib/platform-role.js';
import { publicKeyPem } from '../lib/identity-token.js';
import { emailWayFrom } from '../lib/email-way.js';
import { afterStep, nextTrialStep, trialMessage, type DueStep, type TrialStep } from '../lib/pool-trial.js';
import { MailService } from '../services/MailService.js';
import type { InstanceRecord } from '../lib/instances.js';
import {
  admissionManifests, COMPONENT_RESOURCES, INSTANCE_RELEASE, namespaceManifest, POOL_LABEL, poolChartValues, poolNamespace,
  poolSettingsFrom, PROXY, proxyCaddyfile, proxyManifests, RUNTIME_CLASS, VCLUSTER_CHART_VERSION, vclusterAddress, vclusterValues,
  type PoolSettings,
} from '../lib/pool.js';

const DEFAULT_KUBECONFIG = '/tmp/kubeconfig-provisioning-lunorica';
const ADMISSION_CHECK_NAMESPACE = 'pool-admission-check';
function rootPublicKey(): string {
  const role = roleFromEnv(process.env);
  if (!role.signing) throw ApplicationFailure.nonRetryable('only root makes pool instances', 'NotRoot');
  return publicKeyPem(role.signing.publicKey);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function settings(): PoolSettings {
  const found = poolSettingsFrom(process.env, DEFAULT_KUBECONFIG);
  if ('off' in found) throw ApplicationFailure.nonRetryable(found.off, 'PoolOff');
  return found;
}

const yaml = (docs: Record<string, unknown>[]): string => docs.map((doc) => JSON.stringify(doc)).join('\n---\n');

async function withInstance<T>(instanceId: string, work: (instance: InstanceRecord, save: (patch: Partial<InstanceRecord>) => Promise<InstanceRecord>) => Promise<T>): Promise<T> {
  const db = createDatabase();
  await db.init();
  try {
    const instance = (await db.getInstances()).find((entry) => entry.id === instanceId);
    if (!instance?.pool) throw ApplicationFailure.nonRetryable(`${instanceId} is not a pool instance`, 'NotPool');
    let current = instance;
    return await work(instance, async (patch) => {
      current = { ...current, ...patch, updatedAt: new Date().toISOString() };
      await db.saveInstance(current);
      return current;
    });
  } finally {
    await db.close();
  }
}

export async function PoolHostActivity(): Promise<void> {
  const pool = settings();
  const infra = new InfrastructureService();
  const classes = await infra.runKubectl(['get', 'runtimeclass', '-o', 'name'], pool.kubeconfig);
  if (!classes.split('\n').includes(`runtimeclass.node.k8s.io/${RUNTIME_CLASS}`)) {
    throw ApplicationFailure.nonRetryable('the pool\'s node has no gVisor runtime yet: run scripts/root-node/gvisor.sh on it first', 'NoGvisor');
  }
  await infra.applyManifest(yaml([...admissionManifests(), {
    apiVersion: 'v1', kind: 'Namespace', metadata: { name: ADMISSION_CHECK_NAMESPACE, labels: { [POOL_LABEL]: 'true', 'pod-security.kubernetes.io/enforce': 'baseline' } },
  }]), pool.kubeconfig);
  for (;;) {
    const refused = await infra.runKubectl(['run', 'admission-check', '-n', ADMISSION_CHECK_NAMESPACE, '--image=busybox:1.37', '--restart=Never', '--dry-run=server', '-o', 'name'], pool.kubeconfig)
      .then(() => false, (error: Error) => error.message.includes('runs under gVisor'));
    if (refused) break;
    await sleep(2000);
  }
  const existing = await infra.runKubectl(['get', 'daemonset', PROXY.name, '-n', PROXY.namespace, '-o', 'name'], pool.kubeconfig).catch(() => '');
  if (!existing.trim()) await infra.applyManifest(yaml(proxyManifests(proxyCaddyfile([], pool.address))), pool.kubeconfig);
}

export async function PoolProxyActivity(): Promise<void> {
  const pool = settings();
  const db = createDatabase();
  await db.init();
  try {
    const instances = (await db.getInstances()).filter((entry) => entry.pool && entry.name);
    const caddyfile = proxyCaddyfile(instances.map((entry) => ({ name: entry.name!, ports: entry.pool!.ports })), pool.address);
    await new InfrastructureService().applyManifest(yaml([proxyManifests(caddyfile)[0]!]), pool.kubeconfig);
  } finally {
    await db.close();
  }
}

export async function PoolVclusterActivity(args: { instanceId: string }): Promise<void> {
  const pool = settings();
  const infra = new InfrastructureService();
  await withInstance(args.instanceId, async (instance, save) => {
    const name = instance.name!;
    const namespace = poolNamespace(name);
    await save({ status: 'installing', detail: 'Making your space on Koala\'s servers' });
    await infra.applyManifest(yaml([namespaceManifest(name, instance.ownerId)]), pool.kubeconfig);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-'));
    try {
      const values = path.join(dir, 'vcluster.json');
      await fs.writeFile(values, JSON.stringify(vclusterValues(name, pool.slot)));
      await infra.runHelm(['upgrade', '--install', name, 'vcluster', '--repo', 'https://charts.loft.sh', '--version', VCLUSTER_CHART_VERSION,
        '-n', namespace, '--wait', '--timeout', '720h', '-f', values], pool.kubeconfig);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    for (;;) {
      const secret = await infra.runKubectl(['get', 'secret', `vc-${name}`, '-n', namespace, '-o', 'name'], pool.kubeconfig).catch(() => '');
      if (secret.trim()) break;
      await sleep(2000);
    }
  });
}

export async function PoolChartActivity(args: { instanceId: string }): Promise<void> {
  const pool = settings();
  const infra = new InfrastructureService();
  await withInstance(args.instanceId, async (instance, save) => {
    const name = instance.name!;
    const namespace = poolNamespace(name);
    const domain = process.env.INGRESS_DOMAIN!.trim();
    const credential = crypto.randomBytes(32).toString('base64url');
    const values = poolChartValues({
      instanceId: instance.id,
      ownerId: instance.ownerId,
      rootUrl: process.env.PUBLIC_URL?.trim() || process.env.ROOT_URL?.trim() || '',
      rootPublicKeys: rootPublicKey(),
      credential,
      name,
      domain,
      publicUrl: `https://${name}.${domain}`,
      image: pool.image,
      ports: instance.pool!.ports,
      resources: COMPONENT_RESOURCES,
    });
    await save({ detail: 'Installing Koala in your space', credentialHash: hashCredential(credential) });
    const job = `install-${crypto.randomBytes(4).toString('hex')}`;
    await infra.applyManifest(yaml([
      { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'instance-values', namespace }, stringData: { 'values.json': JSON.stringify(values) } },
      installJob(job, namespace, name, pool.image),
    ]), pool.kubeconfig);
    for (;;) {
      const counts = await infra.runKubectl(['get', 'job', job, '-n', namespace, '-o', 'jsonpath={.status.succeeded}|{.status.failed}'], pool.kubeconfig).catch(() => '|');
      const [succeeded, failed] = counts.split('|');
      if (Number(succeeded) > 0) break;
      if (Number(failed) > 0) {
        const logs = await infra.runKubectl(['logs', `job/${job}`, '-n', namespace, '--tail=30'], pool.kubeconfig).catch(() => '');
        throw new Error(`installing Koala in ${namespace} failed: ${logs.trim().split('\n').slice(-6).join(' | ') || 'no log'}`);
      }
      await sleep(5000);
    }
  });
}

function installJob(job: string, namespace: string, vcluster: string, image: PoolSettings['image']): Record<string, unknown> {
  const script = [
    'set -eu',
    `sed "s|server: .*|server: https://${vclusterAddress(vcluster)}:443|" /vc/config > /tmp/kubeconfig`,
    'chmod 600 /tmp/kubeconfig',
    `/app/bin/helm upgrade --install ${INSTANCE_RELEASE.name} /app/charts/instance -n ${INSTANCE_RELEASE.namespace} --create-namespace --kubeconfig /tmp/kubeconfig -f /values/values.json --timeout 720h`,
  ].join('\n');
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: job, namespace },
    spec: {
      backoffLimit: 2,
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

export async function PoolReadyActivity(args: { instanceId: string }): Promise<void> {
  const pool = settings();
  const infra = new InfrastructureService();
  await withInstance(args.instanceId, async (instance, save) => {
    await save({ detail: 'Starting Koala in your space' });
    const probe = `wget -q -O /dev/null -T 10 http://${pool.address}:${instance.pool!.ports.backend}/api/auth/sign-in`;
    for (;;) {
      const answered = await infra.runKubectl(['exec', '-n', PROXY.namespace, `daemonset/${PROXY.name}`, '--', 'sh', '-c', probe], pool.kubeconfig).then(() => true, () => false);
      if (answered) break;
      await sleep(5000);
    }
    await save({ status: 'ready', detail: 'Ready', url: `https://${instance.name}.${process.env.INGRESS_DOMAIN!.trim()}`, meshIp: pool.address });
  });
}

export async function PoolFailedActivity(args: { instanceId: string; reason: string }): Promise<void> {
  await withInstance(args.instanceId, async (_instance, save) => {
    await save({ status: 'failed', detail: args.reason.slice(0, 500) });
  });
}

export async function PoolTrialNextActivity(args: { instanceId: string; now: number }): Promise<DueStep | null> {
  const db = createDatabase();
  await db.init();
  try {
    const instance = (await db.getInstances()).find((entry) => entry.id === args.instanceId);
    if (!instance?.pool || !instance.name) return null;
    return nextTrialStep(instance.pool, args.now);
  } finally {
    await db.close();
  }
}

async function tell(ownerId: string, message: { subject: string; text: string }): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    const mail = new MailService({ way: emailWayFrom(process.env, roleFromEnv(process.env)), emailOf: async (id) => (await db.getUserById(id))?.email });
    await mail.toOwner(ownerId, message);
  } catch (error) {
    console.warn(`[pool] could not email ${ownerId} "${message.subject}": ${(error as Error).message}`);
  } finally {
    await db.close();
  }
}

async function vclusterReplicas(pool: PoolSettings, name: string, replicas: 0 | 1): Promise<void> {
  const infra = new InfrastructureService();
  const namespace = poolNamespace(name);
  await infra.runKubectl(['scale', 'statefulset', name, '-n', namespace, `--replicas=${replicas}`], pool.kubeconfig);
  if (replicas === 0) {
    await infra.runKubectl(['delete', 'pods', '-n', namespace, '-l', `vcluster.loft.sh/managed-by=${name}`, '--wait=true'], pool.kubeconfig);
  }
}

export async function PoolRemoveActivity(args: { instanceId: string }): Promise<void> {
  const pool = settings();
  const infra = new InfrastructureService();
  const db = createDatabase();
  await db.init();
  try {
    const instance = (await db.getInstances()).find((entry) => entry.id === args.instanceId);
    if (!instance?.pool || !instance.name) return;
    const namespace = poolNamespace(instance.name);
    await infra.runHelm(['uninstall', instance.name, '-n', namespace, '--ignore-not-found', '--wait', '--timeout', '720h'], pool.kubeconfig);
    await infra.runKubectl(['delete', 'namespace', namespace, '--ignore-not-found', '--wait=true'], pool.kubeconfig);
    await db.deleteInstance(instance.id);
  } finally {
    await db.close();
  }
  await PoolProxyActivity();
}

export async function PoolTrialStepActivity(args: { instanceId: string; step: TrialStep; now: number }): Promise<void> {
  const pool = settings();
  const rootUrl = process.env.PUBLIC_URL?.trim() || '';
  const db = createDatabase();
  await db.init();
  let instance: InstanceRecord | undefined;
  try {
    instance = (await db.getInstances()).find((entry) => entry.id === args.instanceId);
  } finally {
    await db.close();
  }
  if (!instance?.pool || !instance.name) return;
  const message = trialMessage(args.step, { name: instance.name, trialEndsAt: instance.pool.trialEndsAt, rootUrl });
  if (args.step === 'delete') {
    await PoolRemoveActivity({ instanceId: instance.id });
    await tell(instance.ownerId, message);
    return;
  }
  if (args.step === 'pause') await vclusterReplicas(pool, instance.name, 0);
  if (args.step === 'resume') await vclusterReplicas(pool, instance.name, 1);
  await withInstance(instance.id, async (current, save) => {
    const trial = afterStep(current.pool!, args.step, args.now);
    await save({
      pool: { ...current.pool!, told: [...(trial.told ?? [])], pausedAt: trial.pausedAt },
      ...(args.step === 'pause' ? { status: 'paused' as const, detail: 'The trial has ended' } : {}),
      ...(args.step === 'resume' ? { status: 'installing' as const, detail: 'Starting Koala in your space' } : {}),
    });
  });
  if (args.step === 'resume') await PoolReadyActivity({ instanceId: instance.id });
  await tell(instance.ownerId, message);
}
