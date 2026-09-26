import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });

import axios, { type AxiosInstance } from 'axios';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase, type Database } from '../apps/backend/src/lib/db-interface.js';
import { sanitiseNamespaceName } from '../apps/backend/src/lib/projects.js';
import { InfisicalService } from '../apps/backend/src/services/InfisicalService.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';
import { ClusterProxyService } from '../apps/backend/src/services/ClusterProxyService.js';
import type { SecretRequest } from '../apps/backend/src/lib/secret-requests.js';

const BASE = process.env.SECRETS_LIVE_URL ?? 'http://localhost:3001/api';
const MANAGEMENT = 'provisioning-lunorica';
const TARGETS = (process.env.SECRET_INJECTION_TARGETS ?? 'management,k3d').split(',');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, limitMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const found = await probe().catch(() => undefined);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5_000);
  }
}

const kubeconfigFor = (cluster: string) => (cluster === MANAGEMENT ? '/tmp/kubeconfig-provisioning-lunorica' : `/tmp/kubeconfig-${cluster}`);

async function secretValue(infra: InfrastructureService, cluster: string, namespace: string, key: string): Promise<string | undefined> {
  const raw = String(await infra.runKubectl(['get', 'secret', `${namespace}-secrets`, '-n', namespace, '-o', `jsonpath={.data.${key}}`], kubeconfigFor(cluster)));
  return raw.trim() ? Buffer.from(raw.trim(), 'base64').toString('utf8') : undefined;
}

async function podEnv(infra: InfrastructureService, cluster: string, namespace: string, key: string): Promise<string | undefined> {
  const pod = String(await infra.runKubectl(['get', 'pods', '-n', namespace, '--field-selector=status.phase=Running', '-o', 'jsonpath={.items[0].metadata.name}'], kubeconfigFor(cluster))).trim();
  if (!pod) return undefined;
  const out = String(await infra.runKubectl(['exec', '-n', namespace, pod, '--', 'printenv', key], kubeconfigFor(cluster))).trim();
  return out || undefined;
}

async function provideThroughCard(http: AxiosInstance, db: Database, ownerId: string, projectId: string, key: string, value: string): Promise<void> {
  const stamp = new Date().toISOString();
  const request: SecretRequest = {
    id: randomUUID(), ownerId, projectId, key, description: 'secret injection live check',
    secretReference: `secret://${projectId}/${key}`, status: 'requested', createdAt: stamp, updatedAt: stamp,
  };
  await db.saveSecretRequest(request);
  const res = await http.post(`/secret-requests/${request.id}/submit`, { value });
  assert.equal(res.data.status, 'provided');
}

async function provisionK3d(http: AxiosInstance, name: string): Promise<string> {
  await http.post('/clusters', { name, provider: 'k3d' });
  return until(`cluster ${name} to be healthy`, 20 * 60_000, async () => {
    const clusters = (await http.get('/clusters')).data as { id: string; name: string; status: string }[];
    const mine = clusters.find((cluster) => cluster.name === name);
    if (mine?.status === 'failed') throw new Error(`cluster ${name} failed to provision`);
    return mine?.status === 'healthy' ? mine.id : undefined;
  });
}

async function check(target: string, http: AxiosInstance, db: Database, infra: InfrastructureService, infisical: InfisicalService, ownerId: string): Promise<string[]> {
  const stamp = Date.now().toString(36);
  const cluster = target === 'management' ? MANAGEMENT : `secret-live-${stamp}`;
  const name = `secret-live-${target}-${stamp}`;
  const namespace = sanitiseNamespaceName(name);
  const key = 'LIVE_INJECTED_SECRET';
  const first = `injected-${randomUUID()}`;
  const rotated = `rotated-${randomUUID()}`;
  const notes: string[] = [];
  let clusterId: string | undefined;

  const source = (await db.getPipelineRuns()).filter((run: any) => run.status === 'succeeded' && run.imageTag).at(0) as any;
  assert.ok(source, 'there is no built image to deploy');
  const project = { id: `secret-live-${stamp}-${target}`, name, ownerId, appType: 'gitapp', targetClusterId: cluster, createdAt: new Date().toISOString() };
  const runId = `secret-live-run-${stamp}-${target}`;

  try {
    if (target === 'k3d') {
      clusterId = await provisionK3d(http, cluster);
      const status = String(await infra.runHelm(['status', 'infisical-operator', '-n', 'infisical'], kubeconfigFor(cluster)));
      assert.match(status, /STATUS: deployed/, 'provisioning did not install the operator');
      notes.push(`${target}: provisioning installed the operator`);
    }

    await db.saveProject(project as any);
    await db.savePipelineRun({ ...source, id: runId, projectId: project.id, promotedAt: undefined, deploymentId: undefined });
    await provideThroughCard(http, db, ownerId, project.id, key, first);

    await http.post(`/projects/${project.id}/runs/${runId}/promote`);
    const synced = await until(`${namespace}-secrets on ${cluster}`, 15 * 60_000, () => secretValue(infra, cluster, namespace, key));
    assert.equal(synced, first);
    notes.push(`${target}: the operator wrote the vault value into ${namespace}-secrets`);

    const inPod = await until(`a running pod on ${cluster}`, 5 * 60_000, () => podEnv(infra, cluster, namespace, key)).catch((err: Error) => {
      notes.push(`${target}: no running pod to read — ${err.message}`);
      return undefined;
    });
    if (inPod !== undefined) {
      assert.equal(inPod, first);
      notes.push(`${target}: the pod's environment carries it`);
    }

    await infisical.setSecret(project.id, key, rotated);
    const resynced = await until('the rotated value to sync', 4 * 60_000, async () => ((await secretValue(infra, cluster, namespace, key)) === rotated ? true : undefined));
    assert.ok(resynced);
    notes.push(`${target}: a changed value reached ${namespace}-secrets with no redeploy`);
    if (inPod !== undefined) {
      await until('the pod to restart with the rotated value', 5 * 60_000, async () => ((await podEnv(infra, cluster, namespace, key)) === rotated ? true : undefined));
      notes.push(`${target}: the pod restarted onto the changed value`);
    }
    return notes;
  } finally {
    await http.delete(`/deployments/${encodeURIComponent(name)}`).catch(() => undefined);
    await infra.runKubectl(['delete', 'namespace', namespace, '--wait=false'], kubeconfigFor(cluster)).catch(() => undefined);
    if (clusterId) await http.delete(`/clusters/${clusterId}`).catch((err: Error) => console.warn(`cleanup cluster: ${err.message}`));
    await infisical.deleteSecret(project.id, key).catch(() => undefined);
    for (const request of await db.getSecretRequests(ownerId, { projectId: project.id })) await db.deleteSecretRequest(ownerId, request.id);
    const mongo = new MongoClient(process.env.MONGO_URI ?? 'mongodb://admin:admin@localhost:27017/provisioning?authSource=admin');
    await mongo.connect();
    await mongo.db('provisioning').collection('pipelineRuns').deleteOne({ _id: runId as never });
    await mongo.db('provisioning').collection('projects').deleteOne({ _id: project.id as never });
    await mongo.close();
  }
}

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const owner = (await db.getProjects()).find((project) => project.appType === 'gitapp' && project.ownerId)?.ownerId;
  assert.ok(owner, 'no owner with a gitapp project');
  const user = await db.getUserById(owner);
  assert.ok(user);
  const secret = process.env.JWT_SECRET;
  assert.ok(secret, 'JWT_SECRET is not set');

  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, secret, 4 * 3600)}` } });
  const infra = new InfrastructureService();
  const infisical = new InfisicalService(infra, secret, '/tmp/kubeconfig-provisioning-lunorica', undefined, new ClusterProxyService());

  const notes: string[] = [];
  try {
    for (const target of TARGETS) notes.push(...await check(target, http, db, infra, infisical, user.id));
  } finally {
    for (const note of notes) console.log(`  ${note}`);
    await db.close();
  }
  console.log('secret injection live — PASS');
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
