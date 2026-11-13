import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import axios, { type AxiosInstance } from 'axios';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { workflowOfRun } from '../apps/backend/src/engine-host/temporal/contracts.js';
import { devKoalaApi, devKoalaDatabase, devKoalaEnv, devKoalaPage, devKoalaTemporal, devKubectl, devOwner, devOwnerSignIn, devPortForward, devRootPage } from './lib/dev-stack.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';
import { describeStopped, startOwnersModels, stopOwnersModels, type StoppedModel } from './lib/owner-models.js';

const NAME = `v1-${Date.now().toString(36)}`;
const MODEL = 'Qwen/Qwen2.5-0.5B-Instruct';
const LOCAL_PORT = 19124;
const ASKED = 'In one short sentence, what are you?';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (message: string) => console.log(`\n▶ ${message}`);

interface Deployment { id: string; name: string; clusterId: string; namespace?: string; status: string; failure?: string }
interface Gpu { vendor: string; model: string; count: number; runtime: boolean }
interface Cluster { id: string; name: string; gpus?: Gpu[]; gpuProblems?: string[] }
interface Device { id: string; name: string; online: boolean }
interface TurnEvent { type: string; runId: string; outcome?: string; reason?: string }
interface Watched { page: Page; problems: string[] }

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

async function watched(context: BrowserContext): Promise<Watched> {
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  return { page, problems };
}

function nothingWentWrong(watching: Watched, during: string): void {
  assert.deepEqual(watching.problems, [], `the page reported problems during ${during}`);
}

const client = (cookie: string): AxiosInstance => axios.create({ baseURL: devKoalaApi, proxy: false, maxRedirects: 0, headers: { Cookie: cookie }, validateStatus: () => true });
const mine = async (api: AxiosInstance): Promise<Deployment[]> => (await api.get('/api/deployments')).data as Deployment[];

const fieldAfter = (page: Page, label: string) => page.locator('label', { hasText: label }).locator('xpath=following-sibling::*[self::input or self::select][1]');

async function generatedTokens(port: number): Promise<number> {
  const metrics = await axios.get(`http://127.0.0.1:${port}/metrics`, { proxy: false, responseType: 'text' });
  return String(metrics.data).split('\n').filter((line) => line.startsWith('vllm:generation_tokens_total')).reduce((sum, line) => sum + Number(line.split(' ').at(-1)), 0);
}

async function main(): Promise<void> {
  const owner = await devOwner();
  const api = client(owner.cookie);
  const machineId = devKoalaEnv().INSTANCE_MACHINE_ID;
  assert.ok(machineId, 'dev\'s Koala names no INSTANCE_MACHINE_ID, so it runs on no machine of its own');
  const clusterId = `machine-${machineId}`;
  const db = devKoalaDatabase();
  await db.init();
  const temporal = await devKoalaTemporal();
  const began = new Date().toISOString();
  const runIds = new Set<string>();
  const conversations = new Set<string>();
  const stopped: StoppedModel[] = [];
  const previousDefault = ((await api.get('/api/models/default')).data as { defaultModelId: string | null }).defaultModelId;
  let deploymentId: string | undefined;
  let forward: ChildProcess | undefined;
  const browser = await chromium.launch();
  let watching: Watched | undefined;

  try {
    watching = await watched(await browser.newContext());
    const { page } = watching;

    step('the owner signs in on root\'s page and lands on their own Koala, signed in through root');
    const { email, password } = devOwnerSignIn();
    await page.goto(devRootPage);
    await page.getByLabel('Email Address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL((url) => url.origin === devKoalaPage);
    const me = await page.request.get(`${devKoalaPage}/api/auth/me`);
    assert.equal(me.status(), 200, 'the instance did not take the session root handed it');
    assert.equal(((await me.json()) as { email: string }).email, email);
    console.log(`  on ${devKoalaPage}, signed in as the instance's owner`);
    nothingWentWrong(watching, 'signing in');

    step('My Machines shows this computer online, and its cluster card shows its two NVIDIA GPUs, usable (the join itself is machine-live\'s, on a VM)');
    const device = ((await api.get('/api/mesh/local-agents')).data as Device[]).find((entry) => entry.id === machineId);
    assert.ok(device, `this computer, ${machineId}, is not among the owner's machines`);
    await page.goto(`${devKoalaPage}/#/mesh`);
    const row = page.locator('div.rounded-2xl', { hasText: device.name }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText('raw access')).toBeVisible();
    const cluster = ((await api.get('/api/clusters')).data as Cluster[]).find((entry) => entry.id === clusterId);
    assert.ok(cluster, `${clusterId} is not among the owner's clusters`);
    await page.goto(`${devKoalaPage}/#/infrastructure`);
    const card = page.getByTestId('cluster-card').filter({ hasText: cluster.name });
    await expect(card.getByText(/^GPUs: 2 × .+ GiB each$/)).toBeVisible({ timeout: 60_000 });
    await expect(card.getByText(/not usable yet|could not be read/)).toHaveCount(0);
    console.log(`  ${device.name} online; ${await card.getByText(/^GPUs:/).innerText()}`);
    nothingWentWrong(watching, 'My Machines and the cluster card');

    step('the owner\'s own models holding GPUs here are stopped for the test, their records kept');
    stopped.push(...await stopOwnersModels(api, clusterId));
    console.log(stopped.length ? `  stopped ${describeStopped(stopped)}` : '  none of the owner\'s models holds a GPU here, so none is stopped');

    step(`Deploy an app: vLLM serving ${MODEL} on this machine, one NVIDIA GPU, through the wizard`);
    await page.getByRole('button', { name: 'Deploy an app' }).click();
    await page.getByLabel('Application Type').selectOption('vllm');
    await page.getByLabel('Instance Name').fill(NAME);
    await page.getByLabel('Target Cluster').selectOption(clusterId);
    await page.getByRole('button', { name: /^Next/ }).click();
    await page.getByRole('button', { name: /Native K8s/ }).click();
    await page.getByRole('button', { name: /^Next/ }).click();
    await page.getByPlaceholder('e.g. llama, mistral, qwen...').fill(MODEL);
    await page.getByRole('button', { name: new RegExp(`${MODEL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} ·`) }).click();
    await page.getByRole('button', { name: /^Next/ }).click();
    await expect(fieldAfter(page, 'HuggingFace Model ID')).toHaveValue(MODEL);
    await fieldAfter(page, 'GPU Count').selectOption('1');
    await fieldAfter(page, 'GPU Vendor').selectOption('nvidia');
    await page.getByRole('button', { name: /Advanced vLLM Arguments/ }).click();
    await fieldAfter(page, 'Max Model Length').fill('4096');
    await fieldAfter(page, 'GPU Memory Utilization').fill('0.5');
    await page.getByRole('button', { name: /^Next/ }).click();
    await expect(page.getByText('Ready to Launch')).toBeVisible();
    const deployed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/deployments' && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Initiate Deployment/ }).click();
    const answer = await deployed;
    assert.equal(answer.status(), 202, `the deploy answered ${answer.status()}: ${await answer.text()}`);
    deploymentId = ((await answer.json()) as { id: string }).id;
    console.log(`  deploying ${NAME} (${deploymentId})`);
    const appRow = page.getByTestId('app-row').filter({ hasText: NAME });
    await expect(appRow).toBeVisible({ timeout: 60_000 });
    const running = await until(`${NAME} running`, async () => {
      const found = (await mine(api)).find((entry) => entry.id === deploymentId);
      if (!found) throw new Hopeless('the deployment is gone from the list');
      if (found.status === 'failed') throw new Hopeless(`the app failed to deploy: ${found.failure ?? 'and its record says no reason'}`);
      return found.status === 'running' ? found : undefined;
    });
    await page.reload();
    await expect(appRow.getByText(/running|healthy/i).first()).toBeVisible({ timeout: 60_000 });
    await appRow.getByRole('button', { name: `Manage ${NAME}` }).click();
    const close = page.getByRole('button', { name: 'Close dashboard' });
    await expect(close).toBeVisible();
    await expect(page.getByText(NAME).first()).toBeVisible();
    await close.click();
    console.log(`  ${NAME} is running in ${running.namespace ?? NAME}, shown on Infrastructure and its page`);
    nothingWentWrong(watching, 'deploying');

    const namespace = running.namespace ?? NAME;
    const services = JSON.parse(await devKubectl(namespace, 'get', 'services', '-o', 'json')) as { items: { metadata: { name: string }; spec: { ports: { port: number }[] } }[] };
    const service = services.items.find((entry) => entry.spec.ports.some((port) => port.port === 8000));
    assert.ok(service, `no service on port 8000 in ${namespace}`);
    forward = devPortForward(namespace, `svc/${service.metadata.name}`, `${LOCAL_PORT}:8000`);
    const tokensBefore = await until('the model\'s metrics', async () => generatedTokens(LOCAL_PORT));

    step('Studio → Models offers the running model by itself, and the owner makes it the default');
    await page.goto(`${devKoalaPage}/#/studio/models`);
    await page.getByLabel('Filter models').first().fill(MODEL);
    const choices = page.getByRole('button', { name: new RegExp(`\\[vLLM\\] ${MODEL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`) });
    await expect(choices.first()).toBeVisible({ timeout: 60_000 });
    assert.equal(await choices.count(), 1, `the owner has ${await choices.count()} vLLM models serving ${MODEL}, so the picker cannot tell this one apart`);
    await choices.first().click();
    await expect(page.getByText(/^Currently:/)).toContainText(MODEL);
    const chosen = ((await api.get('/api/models/default')).data as { defaultModelId: string | null }).defaultModelId;
    assert.equal(chosen, deploymentId, `the default is ${chosen}, not the model just deployed`);
    console.log(`  the default is ${NAME}'s model`);
    nothingWentWrong(watching, 'choosing the default model');

    step('a Koala chat answers from that model, on this machine\'s GPU');
    await page.goto(`${devKoalaPage}/#/chat`);
    await page.getByPlaceholder(/^Message/).fill(ASKED);
    const started = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/engine/runs' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send message' }).click();
    const run = await started;
    assert.equal(run.status(), 201, `starting the turn answered ${run.status()}: ${await run.text()}`);
    const runId = ((await run.json()) as { runId: string }).runId;
    const conversationId = (run.request().postDataJSON() as { conversationId?: string }).conversationId;
    assert.ok(conversationId, 'the chat started a turn for no conversation');
    runIds.add(runId);
    conversations.add(conversationId);
    await temporal.client.workflow.getHandle(workflowOfRun(runId)).result();
    const events = ((await api.get(`/api/turns/${runId}`)).data as { entries: { events: TurnEvent[] }[] }).entries.flatMap((entry) => entry.events);
    const ended = events.find((event) => event.type === 'run.finished' && event.runId === runId);
    assert.equal(ended?.outcome, 'ok', `the turn ended ${JSON.stringify(ended)}`);
    const reply = ((await api.get(`/api/conversations/${conversationId}`)).data as { messages: { role: string; content: string }[] }).messages.filter((message) => message.role === 'assistant').at(-1)?.content.trim() ?? '';
    assert.ok(reply.length > 0, 'the turn saved no answer');
    await expect(page.getByText(reply.split('\n')[0]!.slice(0, 60)).first()).toBeVisible({ timeout: 60_000 });
    const tokensAfter = await generatedTokens(LOCAL_PORT);
    assert.ok(tokensAfter > tokensBefore, `the model generated no tokens for the turn (${tokensBefore} before, ${tokensAfter} after)`);
    console.log(`  it answered ${JSON.stringify(reply.slice(0, 160))}; the model generated ${tokensAfter - tokensBefore} tokens`);
    nothingWentWrong(watching, 'chatting');

    step(`Infrastructure: the owner destroys ${NAME}, and it is gone`);
    await page.goto(`${devKoalaPage}/#/infrastructure`);
    await appRow.getByRole('button', { name: `Destroy ${NAME}` }).click();
    await page.getByRole('button', { name: 'Confirm Delete' }).click();
    await until(`${NAME} gone`, async () => ((await mine(api)).some((entry) => entry.id === deploymentId) ? undefined : true));
    await expect(appRow).toHaveCount(0, { timeout: 60_000 });
    deploymentId = undefined;
    console.log(`  ${NAME} is gone from the list and the page`);
    nothingWentWrong(watching, 'destroying');
  } catch (err) {
    if (watching) {
      const shot = `${process.env.V1_LIVE_SHOTS ?? '/tmp'}/v1-live-${Date.now()}.png`;
      await watching.page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      console.error(`\n── the page at ${watching.page.url()} (screenshot ${shot}) ──\n${(await watching.page.locator('body').innerText().catch(() => '')).slice(0, 2000)}`);
      console.error(`── what the page reported ──\n${watching.problems.join('\n')}`);
    }
    throw err;
  } finally {
    forward?.kill();
    await browser.close();
    if (deploymentId) {
      const gone = await api.delete(`/api/deployments/${deploymentId}`);
      console.log(`  ${NAME} destroyed after the failure: ${gone.status}`);
      await until(`${NAME} gone`, async () => ((await mine(api)).some((entry) => entry.id === deploymentId) ? undefined : true));
    }
    const restored = await api.put('/api/models/default', { modelId: previousDefault });
    console.log(restored.status === 200 ? `  the default is back to ${previousDefault ?? 'none'}` : `  THE DEFAULT COULD NOT BE PUT BACK to ${previousDefault}: ${JSON.stringify(restored.data)}`);
    for (const id of conversations) await api.delete(`/api/conversations/${id}`);
    for await (const workflow of temporal.client.workflow.list({ query: `WorkflowId STARTS_WITH "memory-" AND StartTime >= "${began}"` })) runIds.add(workflow.workflowId);
    await forgetWhatRunsLeft(db, owner.id, new Set([...runIds, ...[...runIds].map((id) => `memory-run-${id}`)]));
    if (stopped.length) {
      await startOwnersModels(stopped);
      console.log(`  the owner's models are started again: ${describeStopped(stopped)}`);
    }
    await temporal.close();
    await db.close?.();
  }
  console.log('\nv1 live — PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
