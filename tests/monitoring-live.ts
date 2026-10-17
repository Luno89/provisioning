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
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';

const run = promisify(execFile);
const BASE = process.env.MONITORING_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.MONITORING_LIVE_OWNER ?? process.env.CHECKS_LIVE_OWNER;
const CLUSTER = 'provisioning-lunorica';
const KUBECONFIG = `/tmp/kubeconfig-${CLUSTER}`;
const KUBECTL = fileURLToPath(new URL('../bin/kubectl', import.meta.url));
const NAME = `alert-live-${Date.now().toString(36)}`;
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

interface Episode { id: string; ruleId?: string; summary: string; startedAt: string; resolvedAt?: string }
interface Notice { role: string; content: string; notice?: { kind: string; refs: { deploymentId?: string } } }

const kubectl = async (...args: string[]) => (await run(KUBECTL, args, { env: { ...process.env, KUBECONFIG } })).stdout.trim();

let http: AxiosInstance | undefined;
let deploymentId: string | undefined;
let conversationId: string | undefined;
const runIds = new Set<string>();

async function main(): Promise<void> {
  assert.ok(OWNER, 'set MONITORING_LIVE_OWNER (or CHECKS_LIVE_OWNER) to the person whose throwaway app this is');
  const db = createDatabase();
  await db.init();
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  http = axios.create({ baseURL: BASE, proxy: false, validateStatus: () => true, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 4 * 3600)}` } });
  const api = http;

  step(`a throwaway app, ${NAME}, is deployed on the system cluster`);
  const made = await api.post('/deployments', { name: NAME, clusterId: CLUSTER, appType: 'audiobookshelf', strategy: 'native' });
  assert.equal(made.status, 202, JSON.stringify(made.data));
  deploymentId = (made.data as { id: string }).id;
  await until('the app running', async () => {
    const found = ((await api.get('/deployments')).data as { id: string; status: string }[]).find((entry) => entry.id === deploymentId);
    if (!found) throw new Hopeless('the deployment is gone from the list');
    if (found.status === 'failed') throw new Hopeless('the app failed to deploy');
    return found.status === 'running' ? found : undefined;
  });
  const namespace = await until('its namespace', async () => {
    const view = (await api.get(`/monitoring/apps/${deploymentId}`)).data as { app: { state: string } };
    return view.app.state === 'ok' ? NAME : undefined;
  });
  console.log(`  Monitoring calls it healthy`);

  step('Koala, on the person\'s own model, reads it and proposes an alert for when it stops answering');
  conversationId = ((await api.post('/conversations', {})).data as { id: string }).id;
  const message = `How is ${NAME} doing? Tell me when it has not answered for 1 minute.`;
  const started = await api.post('/engine/runs', { agent: 'koala', message, inputs: { conversationId }, conversationId });
  assert.ok(started.status < 300, JSON.stringify(started.data));
  const runId = (started.data as { runId: string }).runId;
  runIds.add(runId);
  const card = await until('Koala\'s card', async () => {
    const cards = (await api.get('/actions', { params: { conversationId } })).data as { id: string; kind: string; status: string; summary: string; params: Record<string, string> }[];
    const found = cards.find((entry) => entry.kind === 'set_alert' && entry.status === 'proposed');
    if (found) return found;
    const entries = ((await api.get(`/turns/${runId}`, { params: { after: 0 } })).data as { entries: { events: { type: string; runId?: string }[] }[] }).entries;
    if (entries.some((entry) => entry.events.some((event) => event.type === 'run.finished' && event.runId === runId))) {
      const said = ((await api.get(`/conversations/${conversationId}`)).data as { messages: Notice[] }).messages.filter((entry) => entry.role === 'assistant').at(-1)?.content ?? '';
      throw new Hopeless(`Koala finished without proposing an alert; it said: ${said.slice(0, 400)}`);
    }
    return undefined;
  });
  console.log(`  card: ${card.summary} (${JSON.stringify(card.params)})`);
  assert.equal(card.params.kind, 'down');
  assert.equal(card.params.deploymentId, deploymentId);

  step('nothing is set until the card is applied; applying it sets the alert');
  const before = (await api.get(`/monitoring/apps/${deploymentId}`)).data as { rules: { id: string }[] };
  assert.deepEqual(before.rules, []);
  const applied = await api.post(`/actions/${card.id}/apply`, {});
  assert.equal((applied.data as { status: string }).status, 'applied', JSON.stringify(applied.data));
  const rule = ((await api.get(`/monitoring/apps/${deploymentId}`)).data as { rules: { id: string; summary: string; spec: { forMinutes: number } }[] }).rules[0];
  assert.ok(rule, 'the alert is not on the app');
  console.log(`  set: ${rule.summary}`);
  assert.ok((await kubectl('get', 'prometheusrule', '-n', namespace, '-o', 'name')).includes('koala-alert-'), 'no PrometheusRule on the cluster');

  step('the app stops answering: the alert fires, and the person is told in the conversation it was set in');
  await kubectl('scale', 'deployment', '--all', '--replicas=0', '-n', namespace);
  const fired = await until('the alert firing', async () => {
    const episodes = ((await api.get('/monitoring/alerts')).data as { episodes: Episode[] }).episodes;
    return episodes.find((episode) => episode.ruleId === rule.id && !episode.resolvedAt);
  });
  console.log(`  fired: ${fired.summary}`);
  const firedNotice = await until('the notice', async () => {
    const messages = ((await api.get(`/conversations/${conversationId}`)).data as { messages: Notice[] }).messages;
    return messages.find((entry) => entry.role === 'notice' && entry.notice?.kind === 'alert-firing' && entry.notice.refs.deploymentId === deploymentId);
  });
  console.log(`  notice: ${firedNotice.content}`);
  const overview = (await api.get('/monitoring')).data as { attention: { subject: { id: string }; state: string }[] };
  assert.ok(overview.attention.some((item) => item.subject.id === deploymentId && item.state === 'down'), 'the app is not among what needs attention');

  step('it answers again: the alert resolves, and the person is told that too');
  await kubectl('scale', 'deployment', '--all', '--replicas=1', '-n', namespace);
  await until('the alert resolving', async () => {
    const episodes = ((await api.get('/monitoring/alerts')).data as { episodes: Episode[] }).episodes;
    return episodes.find((episode) => episode.id === fired.id && episode.resolvedAt);
  });
  const resolvedNotice = await until('the resolved notice', async () => {
    const messages = ((await api.get(`/conversations/${conversationId}`)).data as { messages: Notice[] }).messages;
    return messages.find((entry) => entry.role === 'notice' && entry.notice?.kind === 'alert-resolved' && entry.notice.refs.deploymentId === deploymentId);
  });
  console.log(`  notice: ${resolvedNotice.content}`);

  step('removing the alert takes it off the cluster');
  assert.equal((await api.delete(`/monitoring/rules/${rule.id}`)).status, 204);
  assert.ok(!(await kubectl('get', 'prometheusrule', '-n', namespace, '-o', 'name')).includes('koala-alert-'), 'the PrometheusRule is still there');

  await forgetWhatRunsLeft(db, OWNER, runIds);
  console.log('\nmonitoring live — PASS');
}

async function teardown(): Promise<void> {
  if (!http) return;
  const api = http;
  if (deploymentId) {
    await api.delete(`/deployments/${deploymentId}`);
    await until('the app gone', async () => (((await api.get('/deployments')).data as { id: string }[]).some((entry) => entry.id === deploymentId) ? undefined : true));
  }
  if (conversationId) await api.delete(`/conversations/${conversationId}`);
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.error(`\n${signal}: tearing down`);
    void teardown().finally(() => process.exit(130));
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await teardown();
  });
