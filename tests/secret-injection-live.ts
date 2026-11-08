import assert from 'node:assert/strict';
import axios, { type AxiosInstance } from 'axios';
import { randomUUID } from 'node:crypto';
import type { Database } from '../apps/backend/src/platform/lib/db-interface.js';
import { sanitiseNamespaceName } from '../apps/backend/src/projects/lib/projects.js';
import { machineClusterId } from '../apps/backend/src/infrastructure/lib/cluster-name.js';
import type { SecretRequest } from '../apps/backend/src/projects/lib/secret-requests.js';
import { devInKoala, devKoalaApi, devKoalaDatabase, devKoalaEnv, devKubectl, devOwner } from './lib/dev-stack.js';

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

async function secretValue(namespace: string, key: string): Promise<string | undefined> {
  const raw = await devKubectl(namespace, 'get', 'secret', `${namespace}-secrets`, '-o', `jsonpath={.data.${key}}`);
  return raw ? Buffer.from(raw, 'base64').toString('utf8') : undefined;
}

async function podEnv(namespace: string, key: string): Promise<string | undefined> {
  const pod = await devKubectl(namespace, 'get', 'pods', '--field-selector=status.phase=Running', '-o', 'jsonpath={.items[0].metadata.name}');
  if (!pod) return undefined;
  return (await devKubectl(namespace, 'exec', pod, '--', 'printenv', key)) || undefined;
}

const inVault = (step: string): Promise<null> => devInKoala<null>(`
  const { loadKeys } = await import('/app/apps/backend/src/platform/lib/keys.ts');
  const { InfisicalService } = await import('/app/apps/backend/src/infrastructure/services/InfisicalService.ts');
  const { infisicalSettingsFrom } = await import('/app/apps/backend/src/infrastructure/lib/infisical-settings.ts');
  const vault = new InfisicalService(loadKeys(process.env).data, infisicalSettingsFrom(process.env));
  ${step}
  return null;
`);

async function provideThroughCard(http: AxiosInstance, db: Database, ownerId: string, projectId: string, key: string, value: string): Promise<void> {
  const stamp = new Date().toISOString();
  const request: SecretRequest = {
    id: randomUUID(), ownerId, projectId, key, description: 'secret injection live check',
    secretReference: `secret://${projectId}/${key}`, status: 'requested', createdAt: stamp, updatedAt: stamp,
  };
  await db.projects.saveSecretRequest(request);
  const res = await http.post(`/secret-requests/${request.id}/submit`, { value });
  assert.equal(res.data.status, 'provided');
}

async function check(http: AxiosInstance, db: Database, ownerId: string): Promise<string[]> {
  const machine = devKoalaEnv().INSTANCE_MACHINE_ID;
  assert.ok(machine, 'dev\'s Koala names no machine of its own (INSTANCE_MACHINE_ID)');
  const cluster = machineClusterId(machine);
  const stamp = Date.now().toString(36);
  const name = `secret-live-${stamp}`;
  const namespace = sanitiseNamespaceName(name);
  const key = 'LIVE_INJECTED_SECRET';
  const first = `injected-${randomUUID()}`;
  const rotated = `rotated-${randomUUID()}`;
  const notes: string[] = [];

  const source = (await db.releases.getPipelineRuns()).find((run) => run.status === 'succeeded' && run.imageTag);
  assert.ok(source, 'there is no built image to deploy');
  const project = { id: `secret-live-${stamp}`, name, ownerId, appType: 'gitapp' as const, targetClusterId: cluster, createdAt: new Date().toISOString() };
  const runId = `secret-live-run-${stamp}`;

  try {
    await db.projects.saveProject(project);
    const copy = { ...source, id: runId, projectId: project.id };
    delete copy.promotedAt;
    delete copy.deploymentId;
    await db.releases.savePipelineRun(copy);
    await provideThroughCard(http, db, ownerId, project.id, key, first);

    await http.post(`/projects/${project.id}/runs/${runId}/promote`);
    const synced = await until(`${namespace}-secrets on ${cluster}`, 15 * 60_000, () => secretValue(namespace, key));
    assert.equal(synced, first);
    notes.push(`the operator wrote the vault value into ${namespace}-secrets`);

    const inPod = await until(`a running pod on ${cluster}`, 5 * 60_000, () => podEnv(namespace, key)).catch((err: Error) => {
      notes.push(`no running pod to read — ${err.message}`);
      return undefined;
    });
    if (inPod !== undefined) {
      assert.equal(inPod, first);
      notes.push('the pod\'s environment carries it');
    }

    await inVault(`await vault.setSecret(${JSON.stringify(project.id)}, ${JSON.stringify(key)}, ${JSON.stringify(rotated)});`);
    const resynced = await until('the rotated value to sync', 4 * 60_000, async () => ((await secretValue(namespace, key)) === rotated ? true : undefined));
    assert.ok(resynced);
    notes.push(`a changed value reached ${namespace}-secrets with no redeploy`);
    if (inPod !== undefined) {
      await until('the pod to restart with the rotated value', 5 * 60_000, async () => ((await podEnv(namespace, key)) === rotated ? true : undefined));
      notes.push('the pod restarted onto the changed value');
    }
    return notes;
  } finally {
    await http.delete(`/deployments/${encodeURIComponent(name)}`).catch(() => undefined);
    await devKubectl(namespace, 'delete', 'namespace', namespace, '--wait=false').catch(() => undefined);
    await inVault(`await vault.deleteSecret(${JSON.stringify(project.id)}, ${JSON.stringify(key)});`).catch(() => undefined);
    for (const request of await db.projects.getSecretRequests(ownerId, { projectId: project.id })) await db.projects.deleteSecretRequest(ownerId, request.id);
    await db.projects.removeProjectRecords(project.id);
  }
}

async function main(): Promise<void> {
  const owner = await devOwner();
  const db = devKoalaDatabase();
  await db.init();
  const http = axios.create({ baseURL: `${devKoalaApi}/api`, proxy: false, headers: { Cookie: owner.cookie } });
  const notes: string[] = [];
  try {
    notes.push(...await check(http, db, owner.id));
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
