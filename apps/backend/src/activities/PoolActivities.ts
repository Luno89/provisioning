import crypto from 'crypto';
import { ApplicationFailure } from '@temporalio/common';
import { createDatabase, roleFromEnv, emailWayFrom, loadKeys, MailService } from '../platform/index.js';
import { clusterAccessFrom, HeadscaleService, ROOT_CLUSTER_ID, type ClusterAccess } from '../infrastructure/index.js';
import {
  hashCredential, publicKeyPem, afterStep, nextTrialStep, trialMessage, type DueStep, type TrialStep, MoveRelay,
  kubeconfigFile, issueMoveToken, type InstanceRecord, COMPONENT_RESOURCES,
  PLATFORM_TAG, poolChartValues, poolSettingsFrom, proxyCaddyfile, type PoolSettings,
} from '../instances/index.js';
import { PoolNode } from './pool-node.js';

function rootPublicKey(): string {
  const role = roleFromEnv(process.env);
  if (!role.signing) throw ApplicationFailure.nonRetryable('only root makes pool instances', 'NotRoot');
  return publicKeyPem(role.signing.publicKey);
}

let access: ClusterAccess | undefined;
const rootCluster = (): ClusterAccess => (access ??= clusterAccessFrom(process.env, { role: roleFromEnv(process.env).role }));
const poolNode = (): PoolNode => new PoolNode({ access: rootCluster(), node: ROOT_CLUSTER_ID });

function settings(): PoolSettings {
  const found = poolSettingsFrom(process.env);
  if ('off' in found) throw ApplicationFailure.nonRetryable(found.off, 'PoolOff');
  return found;
}

async function rootCaddies(): Promise<string[]> {
  const found = await new HeadscaleService(loadKeys(process.env).data, process.env.HEADSCALE_URL || 'http://localhost:8080', process.env.HEADSCALE_API_KEY).taggedAddresses(PLATFORM_TAG);
  if (found.length === 0) throw ApplicationFailure.retryable(`no ${PLATFORM_TAG} node is on the mesh, so the pool's proxy could not tell root's Caddy from anyone else`, 'NoPlatformNode');
  return found;
}

async function withInstance<T>(instanceId: string, work: (instance: InstanceRecord, save: (patch: Partial<InstanceRecord>) => Promise<InstanceRecord>) => Promise<T>): Promise<T> {
  const db = createDatabase();
  await db.init();
  try {
    const instance = (await db.instances.getInstances()).find((entry) => entry.id === instanceId);
    if (!instance?.pool) throw ApplicationFailure.nonRetryable(`${instanceId} is not a pool instance`, 'NotPool');
    let current = instance;
    return await work(instance, async (patch) => {
      current = { ...current, ...patch, updatedAt: new Date().toISOString() };
      await db.instances.saveInstance(current);
      return current;
    });
  } finally {
    await db.close();
  }
}

export async function PoolHostActivity(): Promise<void> {
  await poolNode().ready(settings(), rootCaddies);
}

export async function PoolProxyActivity(): Promise<void> {
  const pool = settings();
  const db = createDatabase();
  await db.init();
  try {
    const instances = (await db.instances.getInstances()).filter((entry) => entry.pool && entry.name);
    const caddyfile = proxyCaddyfile(instances.map((entry) => ({ name: entry.name!, ports: entry.pool!.ports })), pool.address, await rootCaddies());
    await poolNode().proxy(caddyfile);
  } finally {
    await db.close();
  }
}

export async function PoolVclusterActivity(args: { instanceId: string }): Promise<void> {
  const pool = settings();
  await withInstance(args.instanceId, async (instance, save) => {
    await save({ status: 'installing', detail: 'Making your space on Koala\'s servers' });
    await poolNode().vcluster({ name: instance.name!, ownerId: instance.ownerId, registryPort: instance.pool!.ports.registry }, pool.slot);
  });
}

export async function PoolChartActivity(args: { instanceId: string }): Promise<void> {
  const pool = settings();
  await withInstance(args.instanceId, async (instance, save) => {
    const name = instance.name!;
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
    await poolNode().install(name, `install-${crypto.randomBytes(4).toString('hex')}`, values, pool.image);
  });
}

export async function PoolReadyActivity(args: { instanceId: string }): Promise<void> {
  const pool = settings();
  await withInstance(args.instanceId, async (instance, save) => {
    await save({ detail: 'Starting Koala in your space' });
    await poolNode().backendAnswers(pool.address, instance.pool!.ports.backend, `the pool proxy reaching ${instance.name}'s backend`);
    await save({ status: 'ready', detail: 'Ready', url: `https://${instance.name}.${process.env.INGRESS_DOMAIN!.trim()}`, meshIp: pool.address });
  });
}

export async function PoolFailedActivity(args: { instanceId: string; reason: string }): Promise<void> {
  await withInstance(args.instanceId, async (_instance, save) => {
    await save({ status: 'failed', detail: args.reason.slice(0, 500) });
  });
}

export async function PoolTrialNextActivity(args: { instanceId: string; now: number }): Promise<DueStep | { hold: true } | null> {
  const db = createDatabase();
  await db.init();
  try {
    const instance = (await db.instances.getInstances()).find((entry) => entry.id === args.instanceId);
    if (!instance?.pool || !instance.name) return null;
    if (instance.move && instance.move.state !== 'failed') return { hold: true };
    return nextTrialStep(instance.pool, args.now);
  } finally {
    await db.close();
  }
}

async function tell(ownerId: string, message: { subject: string; text: string }): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    const mail = new MailService({ way: emailWayFrom(process.env, roleFromEnv(process.env)), emailOf: async (id) => (await db.accounts.getUserById(id))?.email });
    await mail.toOwner(ownerId, message);
  } catch (error) {
    console.warn(`[pool] could not email ${ownerId} "${message.subject}": ${(error as Error).message}`);
  } finally {
    await db.close();
  }
}

export async function PoolRemoveActivity(args: { instanceId: string }): Promise<void> {
  settings();
  const db = createDatabase();
  await db.init();
  try {
    const instance = (await db.instances.getInstances()).find((entry) => entry.id === args.instanceId);
    if (!instance?.pool || !instance.name) return;
    await poolNode().remove(instance.name);
    await db.instances.deleteInstance(instance.id);
  } finally {
    await db.close();
  }
  await PoolProxyActivity();
}

export async function PoolTrialStepActivity(args: { instanceId: string; step: TrialStep; now: number }): Promise<void> {
  settings();
  const rootUrl = process.env.PUBLIC_URL?.trim() || '';
  const db = createDatabase();
  await db.init();
  let instance: InstanceRecord | undefined;
  try {
    instance = (await db.instances.getInstances()).find((entry) => entry.id === args.instanceId);
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
  if (args.step === 'pause') await poolNode().replicas(instance.name, 0);
  if (args.step === 'resume') await poolNode().replicas(instance.name, 1);
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

async function readInstance(instanceId: string): Promise<InstanceRecord | undefined> {
  const db = createDatabase();
  await db.init();
  try {
    return (await db.instances.getInstances()).find((entry) => entry.id === instanceId);
  } finally {
    await db.close();
  }
}

async function writeInstance(instance: InstanceRecord): Promise<void> {
  const db = createDatabase();
  await db.init();
  try {
    await db.instances.saveInstance({ ...instance, updatedAt: new Date().toISOString() });
  } finally {
    await db.close();
  }
}

function moveRelay(): MoveRelay {
  const role = roleFromEnv(process.env);
  if (!role.signing) throw ApplicationFailure.nonRetryable('only root moves instances', 'NotRoot');
  const signing = role.signing;
  return new MoveRelay({ kubeconfig: async () => kubeconfigFile(await rootCluster().kubeconfigOf(ROOT_CLUSTER_ID))(), sign: (instanceId, part) => issueMoveToken(signing, instanceId, part) });
}

export async function PoolMoveStartActivity(args: { instanceId: string }): Promise<void> {
  const pool = settings();
  const instance = await readInstance(args.instanceId);
  if (!instance?.pool || !instance.name || !instance.move) return;
  if (instance.move.wasPaused) {
    await writeInstance({ ...instance, move: { ...instance.move, detail: 'Starting your stopped instance so it can move' } });
    await poolNode().replicas(instance.name, 1);
    await poolNode().backendAnswers(pool.address, instance.pool.ports.backend, `the pool proxy reaching the backend on port ${instance.pool.ports.backend}`);
    const now = await readInstance(args.instanceId);
    if (now?.move) await writeInstance({ ...now, move: { ...now.move, detail: now.move.state === 'waiting' ? 'Waiting for your machine to run the move command' : now.move.detail } });
  }
}

export async function PoolMoveSwitchActivity(args: { instanceId: string }): Promise<{ name: string } | null> {
  settings();
  const instance = await readInstance(args.instanceId);
  if (!instance?.name) return null;
  const name = instance.name;
  if (instance.move) {
    const { move, pool: _place, ...rest } = instance;
    if (!move.credentialHash || !move.target?.meshIp || !move.target.url) throw ApplicationFailure.nonRetryable('the new machine never said where it answers', 'MoveIncomplete');
    await writeInstance({
      ...rest,
      credentialHash: move.credentialHash,
      meshIp: move.target.meshIp,
      url: move.target.url,
      status: 'ready',
      detail: `Moved to ${move.target.machine ?? 'your machine'}`,
      ...(move.target.machine ? { machine: move.target.machine } : {}),
    });
  }
  await poolNode().remove(name);
  await PoolProxyActivity();
  return { name };
}

export async function PoolMoveStopActivity(args: { instanceId: string; reason: string }): Promise<void> {
  settings();
  const instance = await readInstance(args.instanceId);
  if (!instance?.pool || !instance.name || !instance.move) return;
  const notThawed = await moveRelay().thaw({ name: instance.name, instanceId: instance.id });
  if (notThawed) console.warn(`[pool] ${instance.name} could not be told the move stopped: ${notThawed}`);
  if (instance.move.wasPaused) await poolNode().replicas(instance.name, 0);
  const now = await readInstance(args.instanceId);
  const detail = notThawed ? `${args.reason} Your instance on Koala's servers could not be told, so it takes no work until it restarts (${notThawed}).` : args.reason;
  if (now?.move) await writeInstance({ ...now, move: { ...now.move, state: 'failed', detail: detail.slice(0, 500) } });
}
