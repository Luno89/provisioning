import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });

import axios, { type AxiosInstance } from 'axios';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import type { ActionProposal } from '../apps/backend/src/lib/action-proposals.js';

const BASE = process.env.PLATFORM_LIVE_URL ?? 'http://localhost:3001/api';

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

interface Result { name: string; ok: boolean; digest: string; content?: string }
interface Trace { finish?: unknown; outputs?: { results?: Result[] } }

async function turn(http: AxiosInstance, conversationId: string, message: string): Promise<Result[]> {
  const { runId } = (await http.post('/engine/runs', { agent: 'koala', message, conversationId, inputs: { conversationId } })).data as { runId: string };
  console.log(`  run ${runId}`);
  const traces = await until(`run ${runId}`, 8 * 60_000, async () => {
    const all = (await http.get(`/engine/runs/${runId}/traces`)).data.traces as Trace[];
    return all.some((trace) => trace.finish !== undefined) ? all : undefined;
  });
  const seen = new Map<string, Result>();
  for (const result of traces.flatMap((trace) => trace.outputs?.results ?? [])) seen.set(`${result.name}:${result.digest}`, result);
  return [...seen.values()];
}

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const runs = await db.getPipelineRuns();
  const project = (await db.getProjects()).find((candidate) => candidate.ownerId && runs.some((run) => run.projectId === candidate.id));
  assert.ok(project?.ownerId, 'no project with builds to ask about');
  const user = await db.getUserById(project.ownerId);
  assert.ok(user);
  const secret = process.env.JWT_SECRET;
  assert.ok(secret, 'JWT_SECRET is not set');
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, secret, 3600)}` } });

  const conversationId = (await http.post('/conversations', {})).data.id as string;
  const name = `qd-live-${Date.now().toString(36)}`;
  try {
    const pipeline = (await turn(http, conversationId, `Did the last build of my ${project.name} project succeed?`)).find((result) => result.name === 'get_project_pipeline');
    assert.ok(pipeline?.ok, 'koala did not read the pipeline');
    console.log(`  get_project_pipeline: ${pipeline.digest}`);

    const asked = await turn(http, conversationId, `Deploy a Qdrant vector database for me on the management cluster, call it ${name}.`);
    assert.ok(asked.some((result) => result.name === 'propose_deploy_app' && result.ok), `koala did not propose the deploy: ${JSON.stringify(asked.map((r) => `${r.name}:${r.digest}`))}`);
    assert.equal((await db.getDeployments()).some((dep) => dep.name === name), false, 'something deployed before the card was applied');
    const proposal = ((await http.get('/actions', { params: { conversationId } })).data as ActionProposal[]).find((entry) => entry.kind === 'deploy_app' && entry.params.name === name);
    assert.ok(proposal, 'there is no card for the deploy');
    console.log(`  koala proposed: ${proposal.summary} (${proposal.detail.join('; ')}) — nothing deployed yet`);

    const applied = (await http.post(`/actions/${proposal.id}/apply`)).data as ActionProposal;
    assert.equal(applied.status, 'applied', `applying failed: ${applied.reason}`);
    const running = await until(`${name} to run`, 15 * 60_000, async () => {
      const dep = ((await http.get('/deployments')).data as { name: string; status: string }[]).find((entry) => entry.name === name);
      if (dep?.status === 'failed') throw new Error(`${name} failed`);
      return dep?.status === 'running' ? dep : undefined;
    });
    console.log(`  applying the card deployed ${running.name}: ${running.status}`);
    console.log('platform live — PASS');
  } finally {
    const dep = ((await http.get('/deployments').catch(() => ({ data: [] }))).data as { id: string; name: string }[]).find((entry) => entry.name === name);
    if (dep) await http.delete(`/deployments/${encodeURIComponent(dep.id)}`).catch((err: Error) => console.warn(`cleanup: ${err.message}`));
    await http.delete(`/conversations/${conversationId}`).catch(() => undefined);
    await db.close();
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
