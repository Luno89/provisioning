import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });

import axios, { type AxiosInstance } from 'axios';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import type { EgressGrantRecord, EgressRequest } from '@koala/harness-types';

const BASE = process.env.EGRESS_LIVE_URL ?? 'http://localhost:3001/api';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Result { name: string; ok: boolean; digest: string; content?: string }
interface Trace { finish?: unknown; outputs?: { results?: Result[] } }

async function run(http: AxiosInstance, agent: string, message: string): Promise<Result[]> {
  const { runId } = (await http.post('/engine/runs', { agent, message })).data as { runId: string };
  console.log(`  run ${runId}`);
  const deadline = Date.now() + 12 * 60_000;
  for (;;) {
    const traces = (await http.get(`/engine/runs/${runId}/traces`)).data.traces as Trace[];
    if (traces.some((trace) => trace.finish !== undefined)) {
      const seen = new Map<string, Result>();
      for (const result of traces.flatMap((trace) => trace.outputs?.results ?? [])) seen.set(`${result.name}:${result.digest}`, result);
      return [...seen.values()];
    }
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish`);
    await sleep(4_000);
  }
}

const probe = (host: string) =>
  `Run exactly this command and nothing else: curl -sS -o /dev/null -m 20 -w 'HTTP %{http_code}' https://${host}/ — then report the output. `
  + `If ${host} is blocked, ask for access to ${host} with request_egress (the tests need it), and stop.`;

const curlOutput = (results: Result[]) => results.filter((result) => result.name === 'run_command').map((result) => `${result.digest} ${result.content ?? ''}`).join(' | ');

async function main(): Promise<void> {
  const db = createDatabase();
  await db.init();
  const ownerId = (await db.getProjects()).find((project) => project.ownerId)?.ownerId;
  assert.ok(ownerId);
  const user = await db.getUserById(ownerId);
  await db.close();
  assert.ok(user);
  const secret = process.env.JWT_SECRET;
  assert.ok(secret);
  const http = axios.create({ baseURL: BASE, proxy: false, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, secret, 3600)}` } });

  const agent = `egress-live-${Date.now().toString(36)}`;
  const saved = await http.put(`/agents/${agent}`, {
    slug: agent,
    name: 'Egress live check',
    description: 'Runs one command to test outbound access',
    version: '1',
    prompt: 'You run the command you are given in your workspace and report what it printed.',
    guidance: 'Delegate here to test network access.',
    returns: 'The command output.',
    failures: [{ when: 'the command fails', says: 'its output' }],
    procedure: 'tool-rounds',
    tools: ['run_command', 'request_egress'],
    environment: { terminal: true },
  }, { validateStatus: () => true });
  assert.ok(saved.status < 300, `the persona was not saved: ${JSON.stringify(saved.data)}`);

  try {
    const blocked = await run(http, agent, probe('example.com'));
    assert.ok(!curlOutput(blocked).includes('HTTP 200'), `example.com was reachable before any grant: ${curlOutput(blocked)}`);
    console.log(`  before: ${curlOutput(blocked).slice(0, 160)}`);
    const request = ((await http.get('/egress/requests')).data as EgressRequest[]).find((entry) => entry.agentSlug === agent && entry.host === 'example.com' && entry.status === 'requested');
    assert.ok(request, `the agent did not ask for example.com: ${JSON.stringify(blocked.map((r) => r.name))}`);
    console.log('  it asked for example.com');

    const allowed = await http.post(`/egress/requests/${request.id}/allow`, {}, { validateStatus: () => true });
    assert.equal(allowed.status, 200, `allowing failed: ${JSON.stringify(allowed.data)}`);

    const after = await run(http, agent, probe('example.com'));
    assert.ok(curlOutput(after).includes('HTTP 200'), `example.com is still unreachable after the grant: ${curlOutput(after)}`);
    console.log('  after allowing: example.com answers HTTP 200');

    const other = await run(http, agent, `Run exactly this command and nothing else: curl -sS -o /dev/null -m 20 -w 'HTTP %{http_code}' https://github.com/ — then report the output. Do not ask for access.`);
    assert.ok(!curlOutput(other).includes('HTTP 200'), `github.com became reachable too: ${curlOutput(other)}`);
    console.log('  github.com is still blocked');
    console.log('egress live — PASS');
  } finally {
    for (const grant of (await http.get('/egress/grants', { params: { agent } })).data as EgressGrantRecord[]) {
      await http.post(`/egress/grants/${grant.id}/revoke`).catch(() => undefined);
    }
    await http.delete(`/agents/${agent}`).catch(() => undefined);
  }
}

main().then(() => process.exit(0), (err: unknown) => {
  console.error(err);
  process.exit(1);
});
