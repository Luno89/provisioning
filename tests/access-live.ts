import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });

import axios, { type AxiosInstance } from 'axios';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import type { AccessRequest } from '@koala/harness-types';

const BASE = process.env.ACCESS_LIVE_URL ?? 'http://localhost:3001/api';
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
  const admin = (await db.getUsers()).find((user) => user.isAdmin);
  await db.close();
  assert.ok(admin, 'there is no administrator to test with');
  const secret = process.env.JWT_SECRET;
  assert.ok(secret);
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: admin.id, email: admin.email }, secret, 3600)}` } });

  const conversationId = (await http.post('/conversations', {})).data.id as string;
  try {
    const first = await turn(http, conversationId, 'I think Prometheus in the platform\'s monitoring namespace is unhealthy. Get access to that namespace so you can look at its pods.');
    const reads = first.filter((result) => result.name === 'inspect_resources' && result.ok);
    assert.equal(reads.length, 0, 'monitoring was readable before anyone opened it');
    const request = ((await http.get('/cluster-access', { params: { conversationId } })).data as AccessRequest[]).find((entry) => entry.namespaces.includes('monitoring'));
    assert.ok(request, `koala did not ask to open monitoring: ${JSON.stringify(first.map((r) => `${r.name}:${r.digest}`))}`);
    console.log(`  koala asked to open ${request.namespaces.join(', ')}`);

    const granted = await http.post(`/cluster-access/${request.id}/grant`, {}, { validateStatus: () => true });
    assert.equal(granted.status, 200, `granting failed: ${JSON.stringify(granted.data)}`);

    const second = await turn(http, conversationId, 'It is open now. Look at the pods in the monitoring namespace and tell me whether Prometheus is running.');
    const read = second.find((result) => result.name === 'inspect_resources' && result.ok && (result.content ?? '').includes('prometheus'));
    assert.ok(read, `koala did not read the monitoring pods: ${JSON.stringify(second.map((r) => `${r.name}:${r.digest}`))}`);
    console.log('  once granted, koala read the monitoring pods');
    console.log('access live — PASS');
  } finally {
    await http.delete(`/conversations/${conversationId}`).catch(() => undefined);
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
