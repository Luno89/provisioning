import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });

import axios, { type AxiosInstance } from 'axios';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import type { ActionProposal } from '../apps/backend/src/lib/action-proposals.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';

const BASE = process.env.APP_SPEC_LIVE_URL ?? 'http://localhost:3001/api';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Result { name: string; ok: boolean; digest: string }
interface Trace { finish?: unknown; outputs?: { results?: Result[] } }

async function until<T>(what: string, limitMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const found = await probe().catch(() => undefined);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(4_000);
  }
}

async function turn(http: AxiosInstance, conversationId: string, message: string): Promise<Result[]> {
  const { runId } = (await http.post('/engine/runs', { agent: 'koala', message, conversationId, inputs: { conversationId } })).data as { runId: string };
  console.log(`  run ${runId}`);
  const traces = await until(`run ${runId}`, 8 * 60_000, async () => {
    const all = (await http.get(`/engine/runs/${runId}/traces`)).data.traces as Trace[];
    return all.some((trace) => trace.finish !== undefined) ? all : undefined;
  });
  return traces.flatMap((trace) => trace.outputs?.results ?? []);
}

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const ownerId = (await db.getProjects()).find((project) => project.ownerId)?.ownerId;
  assert.ok(ownerId);
  const user = await db.getUserById(ownerId);
  assert.ok(user);
  const secret = loadKeys(process.env).session;
  assert.ok(secret);
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, secret, 3600)}` } });

  const stamp = Date.now().toString(36);
  const appId = `whoami-${stamp}`;
  const name = `who-${stamp}`;
  const conversationId = (await http.post('/conversations', {})).data.id as string;
  try {
    await turn(http, conversationId, `The catalogue has no ${appId} app. Add one called ${appId} from the image traefik/whoami, which serves HTTP on port 80 and needs about 64Mi of memory.`);
    const proposal = ((await http.get('/actions', { params: { conversationId } })).data as ActionProposal[]).find((entry) => entry.kind === 'add_app_spec');
    assert.ok(proposal, 'koala did not propose the app spec');
    assert.equal((await db.getAppSpecs()).some((spec) => spec.id === appId), false, 'the spec was stored before the card was applied');
    console.log(`  proposed: ${proposal.detail.join('; ')}`);

    const applied = (await http.post(`/actions/${proposal.id}/apply`)).data as ActionProposal;
    assert.equal(applied.status, 'applied', `applying failed: ${applied.reason}`);
    assert.ok((await db.getAppSpecs()).some((spec) => spec.id === appId && spec.ownerId === user.id), 'the spec is not in the catalogue');
    console.log(`  applied: ${appId} is in the catalogue`);

    await turn(http, conversationId, `Now deploy ${appId} as ${name} on the management cluster.`);
    const deploy = ((await http.get('/actions', { params: { conversationId } })).data as ActionProposal[]).find((entry) => entry.kind === 'deploy_app' && entry.params.name === name);
    assert.ok(deploy, 'koala did not propose deploying it');
    assert.equal(((await http.post(`/actions/${deploy.id}/apply`)).data as ActionProposal).status, 'applied');
    const running = await until(`${name} to run`, 12 * 60_000, async () => {
      const dep = ((await http.get('/deployments')).data as { name: string; status: string }[]).find((entry) => entry.name === name);
      if (dep?.status === 'failed') throw new Error(`${name} failed`);
      return dep?.status === 'running' ? dep : undefined;
    });
    console.log(`  deployed from the new spec: ${running.name} ${running.status}`);
    console.log('app spec live — PASS');
  } finally {
    const dep = ((await http.get('/deployments').catch(() => ({ data: [] }))).data as { id: string; name: string }[]).find((entry) => entry.name === name);
    if (dep) await http.delete(`/deployments/${encodeURIComponent(dep.id)}`).catch(() => undefined);
    await db.deleteAppSpec(appId).catch(() => undefined);
    await http.delete(`/conversations/${conversationId}`).catch(() => undefined);
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
