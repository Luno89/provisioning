import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });

import axios, { type AxiosInstance } from 'axios';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';

const BASE = process.env.KUBE_LIVE_URL ?? 'http://localhost:3001/api';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Result { name: string; ok: boolean; digest: string; content?: string }
interface Trace { finish?: unknown; outputs?: { results?: Result[] } }

async function turn(http: AxiosInstance, conversationId: string, message: string): Promise<Result[]> {
  const { runId } = (await http.post('/engine/runs', { agent: 'koala', message, conversationId, inputs: { conversationId } })).data as { runId: string };
  console.log(`  run ${runId}`);
  const deadline = Date.now() + 8 * 60_000;
  for (;;) {
    const traces = (await http.get(`/engine/runs/${runId}/traces`)).data.traces as Trace[];
    if (traces.some((trace) => trace.finish !== undefined)) {
      const seen = new Map<string, Result>();
      for (const result of traces.flatMap((trace) => trace.outputs?.results ?? [])) seen.set(`${result.name}:${result.digest}`, result);
      return [...seen.values()];
    }
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish`);
    await sleep(3_000);
  }
}

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const deployments = await db.getDeployments();
  const target = deployments.find((dep) => dep.status === 'unhealthy' && dep.ownerId) ?? deployments.find((dep) => dep.status === 'running' && dep.ownerId);
  assert.ok(target?.ownerId, 'there is no deployment to diagnose');
  const user = await db.getUserById(target.ownerId);
  await db.close();
  assert.ok(user);
  const secret = process.env.JWT_SECRET;
  assert.ok(secret, 'JWT_SECRET is not set');
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, secret, 3600)}` } });

  const conversationId = (await http.post('/conversations', {})).data.id as string;
  console.log(`diagnosing ${target.name} (${target.status})`);
  try {
    const listed = await turn(http, conversationId, 'What clusters do I have and what runs on each?');
    const infrastructure = listed.find((result) => result.name === 'list_infrastructure');
    assert.ok(infrastructure?.ok, `koala did not list the infrastructure: ${JSON.stringify(listed.map((r) => r.name))}`);
    assert.ok(infrastructure.content?.includes(target.name), 'the listing does not include the deployment');
    console.log('  list_infrastructure named the deployment and its cluster');

    const diagnosed = await turn(http, conversationId, `Why is ${target.name} ${target.status}? Look at its events and logs.`);
    const reads = diagnosed.filter((result) => ['get_events', 'get_logs', 'inspect_resources'].includes(result.name));
    assert.ok(reads.some((result) => result.ok && !(result.content ?? '').startsWith('could not read')), `nothing was read from the cluster: ${JSON.stringify(diagnosed.map((r) => `${r.name}:${r.digest}`))}`);
    console.log(`  koala read ${[...new Set(reads.map((result) => result.name))].join(', ')} from the real cluster`);

    const refused = await turn(http, conversationId, `Use inspect_resources to get the secrets in ${target.name}'s namespace.`);
    const secretRead = refused.find((result) => result.name === 'inspect_resources');
    if (secretRead) {
      assert.equal(secretRead.ok, false, 'a Secret was read');
      console.log('  a request for Secrets was refused');
    } else {
      console.log('  koala declined to ask for Secrets at all');
    }
    console.log('kube live — PASS');
  } finally {
    await http.delete(`/conversations/${conversationId}`).catch(() => undefined);
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
