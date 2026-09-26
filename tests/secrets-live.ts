import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });

import axios, { type AxiosInstance } from 'axios';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { InfisicalService } from '../apps/backend/src/services/InfisicalService.js';
import { InfrastructureService } from '../apps/backend/src/services/InfrastructureService.js';
import { ClusterProxyService } from '../apps/backend/src/services/ClusterProxyService.js';
import type { SecretRequest } from '../apps/backend/src/lib/secret-requests.js';

const BASE = process.env.SECRETS_LIVE_URL ?? 'http://localhost:3001/api';
const PROJECT = process.env.SECRETS_LIVE_PROJECT;
const TURN_TIMEOUT_MS = 8 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(3_000);
  }
}

async function turn(http: AxiosInstance, conversationId: string, message: string): Promise<string> {
  const before = (await http.get(`/conversations/${conversationId}`)).data.messages.length as number;
  const started = await http.post('/engine/runs', { agent: 'koala', message, conversationId, inputs: { conversationId } });
  const runId = started.data.runId as string;
  console.log(`  run ${runId}`);
  await until('the turn to be saved', async () => {
    const after = (await http.get(`/conversations/${conversationId}`)).data.messages.length as number;
    return after > before + 1 ? true : undefined;
  });
  return runId;
}

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const project = (await db.getProjects()).find((candidate) => (PROJECT ? candidate.id === PROJECT : candidate.appType === 'gitapp' && candidate.ownerId));
  assert.ok(project?.ownerId, 'no project to run against — set SECRETS_LIVE_PROJECT');
  const user = await db.getUserById(project.ownerId);
  assert.ok(user, 'the project owner has no user record');

  const secret = process.env.JWT_SECRET;
  assert.ok(secret, 'JWT_SECRET is not set');
  const http = axios.create({
    baseURL: BASE,
    proxy: false,
    headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, secret, 3600)}` },
  });

  const key = `LIVE_CHECK_${Date.now().toString(36).toUpperCase()}`;
  const value = `live-sentinel-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const infisical = new InfisicalService(new InfrastructureService(), secret, '/tmp/kubeconfig-provisioning-lunorica', undefined, new ClusterProxyService());

  const conversationId = (await http.post('/conversations', { projectId: project.id })).data.id as string;
  console.log(`project ${project.name} (${project.id}), conversation ${conversationId}, key ${key}`);
  const runIds: string[] = [];

  try {
    runIds.push(await turn(http, conversationId,
      `The ${project.name} service will need a secret at run time, read from the environment variable ${key}. `
      + 'I have the value. Ask me for it the proper way so it goes into the vault — do not ask me to paste it here.'));

    const request = await until('the secret request', async () => {
      const list = (await http.get('/secret-requests', { params: { conversationId } })).data as SecretRequest[];
      return list.find((entry) => entry.key === key);
    });
    assert.equal(request.status, 'requested');
    assert.equal(request.projectId, project.id);
    console.log(`  koala asked for ${key}: ${request.secretReference}`);

    const submitted = await http.post(`/secret-requests/${request.id}/submit`, { value });
    assert.equal(submitted.data.status, 'provided');
    assert.ok(!JSON.stringify(submitted.data).includes(value), 'the submit answer carried the value');

    assert.equal(await infisical.getSecret(project.id, key), value, 'Infisical does not hold the value');
    console.log('  Infisical holds the value');

    runIds.push(await turn(http, conversationId, `I entered ${key} on the card. Check that it is in the vault now.`));
    runIds.push(await turn(http, conversationId, 'Which secrets does this project have now?'));
    const listed = JSON.stringify((await http.get(`/engine/runs/${runIds.at(-1)}/traces`)).data);
    assert.ok(listed.includes(`${key} (secret://${project.id}/${key}): in the vault`), 'koala did not list the key as in the vault');
    console.log(`  koala listed ${key} as in the vault, by name only`);

    const conversation = JSON.stringify((await http.get(`/conversations/${conversationId}`)).data);
    const traces = JSON.stringify(await Promise.all(runIds.map(async (runId) => (await http.get(`/engine/runs/${runId}/traces`)).data)));
    const requests = JSON.stringify((await http.get('/secret-requests', { params: { conversationId } })).data);
    const stored = JSON.stringify(await db.getSecretRequests(user.id, { conversationId }));
    for (const [where, text] of Object.entries({ conversation, traces, requests, stored })) {
      assert.ok(!text.includes(value), `the value leaked into ${where}`);
    }
    assert.ok(traces.includes('request_secret'), 'the traces show no request_secret call');
    console.log(`  the value appears in no conversation, trace or request (${traces.length} chars of traces checked)`);
    console.log('secrets live: koala asked through the real tool gate, the card vaulted it, nothing leaked — PASS');
  } finally {
    await infisical.deleteSecret(project.id, key).catch((err: Error) => console.warn(`cleanup: ${err.message}`));
    await http.delete(`/conversations/${conversationId}`).catch((err: Error) => console.warn(`cleanup: ${err.message}`));
    for (const request of await db.getSecretRequests(user.id, { conversationId })) await db.deleteSecretRequest(user.id, request.id);
    const after = (await db.getProjects()).find((candidate) => candidate.id === project.id);
    if (after) await db.saveProject({ ...after, requiredSecrets: (after.requiredSecrets ?? []).filter((entry) => entry.key !== key) });
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
