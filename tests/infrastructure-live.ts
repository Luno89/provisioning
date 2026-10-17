import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios, { type AxiosInstance } from 'axios';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { memoryRunId } from '../apps/backend/src/lib/conclusions.js';
import { getTemporalClient } from '../apps/backend/src/lib/temporal-client.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';

const run = promisify(execFile);
const BASE = process.env.INFRASTRUCTURE_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.INFRASTRUCTURE_LIVE_OWNER ?? process.env.CHECKS_LIVE_OWNER;
const CLUSTER = 'provisioning-lunorica';
const KUBECONFIG = `/tmp/kubeconfig-${CLUSTER}`;
const KUBECTL = fileURLToPath(new URL('../bin/kubectl', import.meta.url));
const NAMESPACE = `infra-live-${Date.now().toString(36)}`;
const WORKLOAD = 'cannot-pull';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (message: string) => console.log(`\n▶ ${message}`);

class Hopeless extends Error {}

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  let last = '';
  for (let tries = 0; ; tries += 1) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      if (err instanceof Hopeless) throw err;
      last = (err as Error).message;
    }
    if (tries > 0 && tries % 12 === 0) console.log(`  still waiting for ${what}${last ? ` (${last.slice(0, 200)})` : ''}`);
    await sleep(5000);
  }
}

interface Workload { namespace: string; name: string; group: string; state: string; reasons: string[]; clusterId?: string }
interface Failure { id: string; title: string; reason: string; opens: { kind: string; id?: string } }
interface Overview { workloads: Workload[]; failures: Failure[]; waiting: unknown[]; monitoring: { attention: unknown[] } }

const kubectl = async (...args: string[]) => (await run(KUBECTL, args, { env: { ...process.env, KUBECONFIG } })).stdout.trim();

let http: AxiosInstance | undefined;
let closeDb: (() => Promise<void>) | undefined;
let conversationId: string | undefined;
let namespaceMade = false;
let stopping = false;
const runIds = new Set<string>();

async function main(): Promise<void> {
  assert.ok(OWNER, 'set INFRASTRUCTURE_LIVE_OWNER (or CHECKS_LIVE_OWNER) to the person whose page this reads');
  const db = createDatabase();
  await db.init();
  closeDb = async () => { await db.close?.(); };
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  http = axios.create({ baseURL: BASE, proxy: false, validateStatus: () => true, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 4 * 3600)}` } });
  const api = http;
  const overview = async (): Promise<Overview> => {
    const res = await api.get('/infrastructure');
    if (res.status !== 200) throw new Error(`GET /infrastructure answered ${res.status}: ${JSON.stringify(res.data)}`);
    return res.data as Overview;
  };

  step('the page reads every cluster the owner has, and what runs');
  const before = await overview();
  console.log(`  ${before.monitoring.attention.length} apps or clusters need attention, ${before.workloads.length} workloads are broken, ${before.failures.length} failures shown`);

  step(`something that cannot pull its image is put on the system cluster by hand, in ${NAMESPACE}`);
  await kubectl('create', 'namespace', NAMESPACE);
  namespaceMade = true;
  await kubectl('create', 'deployment', WORKLOAD, '-n', NAMESPACE, '--image=registry.invalid/nothing-here:1');
  const broken = await until('it to show as needing attention', async () => (await overview()).workloads.find((workload) => workload.namespace === NAMESPACE));
  assert.equal(broken.name, WORKLOAD);
  assert.equal(broken.state, 'down');
  assert.equal(broken.group, 'other');
  assert.deepEqual(broken.reasons, ['its image cannot be pulled']);
  console.log(`  Needs attention: ${broken.name} in ${broken.namespace}, ${broken.reasons.join('; ')}`);
  const contents = (await api.get(`/infrastructure/clusters/${CLUSTER}`)).data as { workloads: Workload[]; services?: Array<{ key: string; state: string }> };
  assert.ok(contents.workloads.some((workload) => workload.namespace === NAMESPACE && workload.group === 'other'), 'the cluster page does not list it among what was not deployed through Koala');
  assert.equal(contents.services?.find((service) => service.key === 'prometheus')?.state, 'ok');
  console.log('  the cluster page lists it under "Not deployed through Koala", beside Prometheus running');

  step('it is removed, and leaves the list');
  await kubectl('delete', 'namespace', NAMESPACE, '--wait=true');
  namespaceMade = false;
  await until('it to leave Needs attention', async () => ((await overview()).workloads.some((workload) => workload.namespace === NAMESPACE) ? undefined : true));
  console.log('  gone');

  step('a Koala chat turn fails, asked to run on a model that does not exist');
  conversationId = ((await api.post('/conversations', { title: 'Infrastructure live test' })).data as { id: string }).id;
  const started = await api.post('/engine/runs', { agent: 'koala', message: 'Say hello.', inputs: { conversationId }, conversationId, modelId: `no-such-model-${NAMESPACE}` });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const runId = (started.data as { runId: string }).runId;
  runIds.add(runId);
  runIds.add(memoryRunId(runId));
  const failure = await until('the failure to show', async () => (await overview()).failures.find((entry) => entry.id === `run:${runId}`));
  assert.equal(failure.opens.kind, 'chat');
  assert.equal(failure.opens.id, conversationId);
  assert.match(failure.title, /Koala answering in "Infrastructure live test"/);
  console.log(`  Needs attention: ${failure.title}, failed: ${failure.reason}`);

  step('it is cleared, and stays cleared');
  const cleared = await api.post('/infrastructure/failures/clear', { ids: [failure.id] });
  assert.deepEqual(cleared.data, { cleared: 1 });
  assert.ok(!(await overview()).failures.some((entry) => entry.id === failure.id), 'the failure is still shown after Clear');
  console.log('  cleared');

  step('the memory keeper reads the failed run, and the conversation once it goes quiet; whatever it keeps from this made-up failure is retired');
  const temporal = await getTemporalClient();
  await until('the memory keeper to finish', async () => {
    const described = await temporal.workflow.getHandle(memoryRunId(runId)).describe().catch(() => undefined);
    return described && described.status.name !== 'RUNNING' ? described.status.name : undefined;
  });
  await until('the conversation to go quiet', async () => {
    const described = await temporal.workflow.getHandle(`conclude-conversation-${conversationId}`).describe().catch(() => undefined);
    return !described || described.status.name !== 'RUNNING' ? true : undefined;
  });
  await until('the memory keeper to finish reading the conversation', async () => {
    let running = false;
    for await (const workflow of temporal.workflow.list({ query: `WorkflowId STARTS_WITH "memory-conversation-${conversationId}"` })) {
      runIds.add(workflow.workflowId);
      if (workflow.status.name === 'RUNNING') running = true;
    }
    return running ? undefined : true;
  });
  const forgotten = await forgetWhatRunsLeft(db, OWNER, runIds);
  console.log(`  ${forgotten} kept thing${forgotten === 1 ? '' : 's'} retired`);

  console.log('\ninfrastructure live — PASS');
}

async function teardown(): Promise<void> {
  if (namespaceMade) await kubectl('delete', 'namespace', NAMESPACE, '--wait=false').catch(() => undefined);
  if (http && conversationId) await http.delete(`/conversations/${conversationId}`).catch(() => undefined);
  await closeDb?.();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: cleaning up`);
    void teardown().finally(() => process.exit(130));
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (stopping) return;
    await teardown();
    process.exit();
  });
