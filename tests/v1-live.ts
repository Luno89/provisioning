import assert from 'node:assert/strict';
import axios, { type AxiosInstance } from 'axios';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { workflowOfRun } from '../apps/backend/src/engine-host/temporal/contracts.js';
import { TABBYAPI_IMAGE, VLLM_IMAGE } from '../apps/backend/src/infrastructure/lib/model-images.js';
import { DEV_NAMESPACE, devKoalaApi, devKoalaDatabase, devKoalaEnv, devKoalaPage, devKoalaTemporal, devKubectl, devOwner, devOwnerSignIn, devPortForward, devRootPage } from './lib/dev-stack.js';
import { forgetWhatRunsLeft } from './lib/forget-test-runs.js';
import { madeHere } from './lib/made-here.js';
import { nothingWentWrong, watched, type Watched } from './lib/watched-page.js';
import { noAppHoldsAGpu } from './lib/gpus-free.js';
import { until, Hopeless } from './lib/until.js';

const STAMP = Date.now().toString(36);
const LOCAL_PORT = 19124;
const ASKED = 'In one short sentence, what are you?';
const step = (message: string) => console.log(`\n▶ ${message}`);
const literally = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

interface Deployment { id: string; name: string; clusterId: string; namespace?: string; status: string; failure?: string }
interface Gpu { vendor: string; model: string; count: number; runtime: boolean }
interface Cluster { id: string; name: string; gpus?: Gpu[]; gpuProblems?: string[] }
interface Device { id: string; name: string; online: boolean }
interface TurnEvent { type: string; runId: string; outcome?: string; reason?: string }

const client = (cookie: string): AxiosInstance => axios.create({ baseURL: devKoalaApi, proxy: false, maxRedirects: 0, headers: { Cookie: cookie }, validateStatus: () => true });
const mine = async (api: AxiosInstance): Promise<Deployment[]> => (await api.get('/api/deployments')).data as Deployment[];

async function vllmTokens(port: number): Promise<number> {
  const metrics = await axios.get(`http://127.0.0.1:${port}/metrics`, { proxy: false, responseType: 'text' });
  return String(metrics.data).split('\n').filter((line) => line.startsWith('vllm:generation_tokens_total')).reduce((sum, line) => sum + Number(line.split(' ').at(-1)), 0);
}

async function tabbyTokens(namespace: string): Promise<number> {
  const deployments = JSON.parse(await devKubectl(namespace, 'get', 'deployments', '-o', 'json')) as { items: { metadata: { name: string } }[] };
  const [server] = deployments.items;
  assert.ok(server, `no TabbyAPI deployment in ${namespace}`);
  const logs = await devKubectl(namespace, 'logs', `deployment/${server.metadata.name}`, '--all-containers');
  return [...logs.matchAll(/(\d+) tokens generated/g)].reduce((sum, found) => sum + Number(found[1]), 0);
}

interface Served {
  app: 'vLLM' | 'TabbyAPI';
  name: string;
  model: string;
  image: string;
  wizard: (page: Page, name: string, clusterId: string) => Promise<void>;
  generated: (namespace: string) => Promise<{ tokens: () => Promise<number>; stop: () => void }>;
}

const VLLM: Served = {
  app: 'vLLM',
  name: `v1-${STAMP}`,
  model: 'Qwen/Qwen2.5-0.5B-Instruct',
  image: VLLM_IMAGE,
  wizard: async (page, name, clusterId) => {
    await page.getByLabel('Application Type').selectOption('vllm');
    await page.getByLabel('Instance Name').fill(name);
    await page.getByLabel('Target Cluster').selectOption(clusterId);
    await page.getByRole('button', { name: /^Next/ }).click();
    await page.getByRole('button', { name: /Native K8s/ }).click();
    await page.getByRole('button', { name: /^Next/ }).click();
    await page.getByLabel('Search Hugging Face Models').fill(VLLM.model);
    await page.getByRole('button', { name: new RegExp(`${literally(VLLM.model)} ·`) }).click();
    await page.getByRole('button', { name: /^Next/ }).click();
    await expect(page.getByLabel('HuggingFace Model ID')).toHaveValue(VLLM.model);
    await page.getByLabel('GPU Count').selectOption('1');
    await page.getByLabel('GPU Vendor').selectOption('nvidia');
    await expect(page.getByLabel('Serve tool calling')).toBeChecked();
    await expect(page.getByLabel('Tool Call Parser').locator('option:checked')).toHaveText('Chosen from its chat template: hermes');
    await page.getByRole('button', { name: /Advanced vLLM Arguments/ }).click();
    await page.getByLabel(/^Max Model Length/).fill('32768');
    await page.getByLabel(/^GPU Memory Utilization/).fill('0.5');
  },
  generated: async (namespace) => {
    const services = JSON.parse(await devKubectl(namespace, 'get', 'services', '-o', 'json')) as { items: { metadata: { name: string }; spec: { ports: { port: number }[] } }[] };
    const service = services.items.find((entry) => entry.spec.ports.some((port) => port.port === 8000));
    assert.ok(service, `no service on port 8000 in ${namespace}`);
    const forward = devPortForward(namespace, `svc/${service.metadata.name}`, `${LOCAL_PORT}:8000`);
    return { tokens: () => vllmTokens(LOCAL_PORT), stop: () => { forward.kill(); } };
  },
};

const TABBY: Served = {
  app: 'TabbyAPI',
  name: `v1t-${STAMP}`,
  model: 'turboderp/Qwen3.5-9B-exl3',
  image: TABBYAPI_IMAGE,
  wizard: async (page, name, clusterId) => {
    await page.getByLabel('Application Type').selectOption('tabbyapi');
    await page.getByLabel('Instance Name').fill(name);
    await page.getByLabel('Target Cluster').selectOption(clusterId);
    await page.getByRole('button', { name: /^Next/ }).click();
    await page.getByRole('button', { name: /Native K8s/ }).click();
    await page.getByRole('button', { name: /^Next/ }).click();
    await page.getByLabel('Search Hugging Face Models').fill(TABBY.model);
    await page.getByRole('button', { name: new RegExp(`${literally(TABBY.model)} ·`) }).click();
    await page.getByRole('button', { name: '4.00bpw', exact: true }).click();
    await page.getByRole('button', { name: /^Next/ }).click();
    await expect(page.getByLabel('HuggingFace Model ID')).toHaveValue(TABBY.model);
    await expect(page.getByLabel(/^Revision/)).toHaveValue('4.00bpw');
    await page.getByLabel('GPU Count').selectOption('1');
    await page.getByRole('button', { name: /Advanced TabbyAPI Arguments/ }).click();
    await page.getByLabel(/^Max Sequence Length/).fill('32768');
    await expect(page.getByLabel('Tool Call Format').locator('option:checked')).toHaveText('qwen3_coder');
  },
  generated: async (namespace) => ({ tokens: () => tabbyTokens(namespace), stop: () => undefined }),
};

async function main(): Promise<void> {
  const owner = await devOwner();
  const api = client(owner.cookie);
  const machineId = devKoalaEnv().INSTANCE_MACHINE_ID;
  assert.ok(machineId, 'dev\'s Koala names no INSTANCE_MACHINE_ID, so it runs on no machine of its own');
  const clusterId = `machine-${machineId}`;
  const db = devKoalaDatabase();
  await db.init();
  const temporal = await devKoalaTemporal();
  const runIds = new Set<string>();
  const chats = madeHere<{ id: string; updatedAt?: string }>({ name: 'conversations', list: async () => (await api.get('/api/conversations')).data as { id: string; updatedAt?: string }[], idOf: (chat) => chat.id, stampOf: (chat) => chat.updatedAt });
  const previousDefault = ((await api.get('/api/models/default')).data as { defaultModelId: string | null }).defaultModelId;
  await chats.before();
  let deploymentId: string | undefined;
  let stopWatching: () => void = () => undefined;
  let current: string | undefined;
  const browser = await chromium.launch();
  let watching: Watched | undefined;

  const serves = async (served: Served): Promise<void> => {
    const NAME = served.name;
    const seen = watching!;
    const page = seen.page;
    current = NAME;
    step(`Deploy an app: ${served.app} serving ${served.model} on this machine, one NVIDIA GPU, through the wizard`);
    await page.getByRole('button', { name: 'Deploy an app' }).click();
    await served.wizard(page, NAME, clusterId);
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
    const images = (await devKubectl(running.namespace ?? NAME, 'get', 'pods', '-o', 'jsonpath={.items[*].spec.containers[*].image}')).split(/\s+/);
    assert.ok(images.includes(served.image), `${served.app} runs ${images.join(', ')}, not the build Koala pins, ${served.image}`);
    console.log(`  it runs the build Koala pins: ${served.image}`);
    nothingWentWrong(seen, 'deploying');

    const generation = await served.generated(running.namespace ?? NAME);
    stopWatching = generation.stop;
    const tokensBefore = await until('the model\'s generation count', async () => generation.tokens(), async () => {
      const found = (await mine(api)).find((entry) => entry.id === deploymentId);
      return found && found.status !== 'failed' ? undefined : `${NAME} is ${found ? 'failed' : 'gone'}, so it will not report tokens`;
    });

    step('Studio → Models offers the running model by itself, and the owner makes it the default');
    await page.goto(`${devKoalaPage}/#/studio/models`);
    await page.getByLabel('Filter models').first().fill(served.model);
    const choice = page.getByRole('button', { name: new RegExp(`^${literally(`${served.model} · ${NAME}`)}`) });
    await expect(choice).toBeVisible({ timeout: 60_000 });
    await choice.click();
    await expect(page.getByText(/^Currently:/)).toContainText(`${served.model} · ${NAME}`);
    const chosen = ((await api.get('/api/models/default')).data as { defaultModelId: string | null }).defaultModelId;
    assert.equal(chosen, deploymentId, `the default is ${chosen}, not the model just deployed`);
    console.log(`  the default is ${NAME}'s model`);
    nothingWentWrong(seen, 'choosing the default model');

    step('a Koala chat answers from that model, on this machine\'s GPU');
    await page.goto(`${devKoalaPage}/#/chat`);
    const [opened] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/conversations' && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'New chat', exact: true }).click(),
    ]);
    assert.ok(opened.ok(), `making a new chat answered ${opened.status()}: ${await opened.text()}`);
    const conversationId = ((await opened.json()) as { id: string }).id;
    chats.made(conversationId);
    await page.waitForURL((url) => url.hash.includes(conversationId));
    console.log(`  in a new chat of its own, ${conversationId}`);
    await page.getByPlaceholder(/^Message/).fill(ASKED);
    const [run] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/api/engine/runs' && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Send message' }).click(),
    ]);
    assert.equal(run.status(), 201, `starting the turn answered ${run.status()}: ${await run.text()}`);
    const runId = ((await run.json()) as { runId: string }).runId;
    assert.equal((run.request().postDataJSON() as { conversationId?: string }).conversationId, conversationId, 'the turn started in another chat than the one the suite made');
    runIds.add(runId);
    await temporal.client.workflow.getHandle(workflowOfRun(runId)).result();
    const events = ((await api.get(`/api/turns/${runId}`)).data as { entries: { events: TurnEvent[] }[] }).entries.flatMap((entry) => entry.events);
    const ended = events.find((event) => event.type === 'run.finished' && event.runId === runId);
    assert.equal(ended?.outcome, 'ok', `the turn ended ${JSON.stringify(ended)}`);
    const reply = ((await api.get(`/api/conversations/${conversationId}`)).data as { messages: { role: string; content: string }[] }).messages.filter((message) => message.role === 'assistant').at(-1)?.content.trim() ?? '';
    assert.ok(reply.length > 0, 'the turn saved no answer');
    await expect(page.getByText(reply.split('\n')[0]!.slice(0, 60)).first()).toBeVisible({ timeout: 60_000 });
    const tokensAfter = await generation.tokens();
    assert.ok(tokensAfter > tokensBefore, `the model generated no tokens for the turn (${tokensBefore} before, ${tokensAfter} after)`);
    console.log(`  it answered ${JSON.stringify(reply.slice(0, 160))}; the model generated ${tokensAfter - tokensBefore} tokens`);
    nothingWentWrong(seen, 'chatting');

    step(`Infrastructure: the owner destroys ${NAME}, and it is gone`);
    await page.goto(`${devKoalaPage}/#/infrastructure`);
    await appRow.getByRole('button', { name: `Destroy ${NAME}` }).click();
    await page.getByRole('button', { name: 'Confirm Delete' }).click();
    await until(`${NAME} gone`, async () => ((await mine(api)).some((entry) => entry.id === deploymentId) ? undefined : true), async () => {
      const found = (await mine(api)).find((entry) => entry.id === deploymentId);
      return found?.status === 'failed' ? `destroying it failed: ${String(found.failure ?? 'and its record says no reason')}` : undefined;
    });
    await expect(appRow).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Close dashboard' }), 'the destroyed app\'s dashboard did not close once it was gone').toHaveCount(0, { timeout: 60_000 });
    deploymentId = undefined;
    stopWatching();
    stopWatching = () => undefined;
    console.log(`  ${NAME} is gone from the list and the page`);
    nothingWentWrong(seen, 'destroying');
  };

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
    const firstModel = page.getByRole('heading', { name: 'Give Koala a model to think with' });
    await expect(firstModel).toBeVisible();
    await page.getByRole('button', { name: 'Later', exact: true }).click();
    await expect(firstModel).toHaveCount(0);
    console.log('  asked for a first model, which the owner puts off until their own is deployed');

    step('My Machines shows this computer online with its two NVIDIA GPUs, usable, as does its cluster card (the join itself is machine-live\'s, on a VM)');
    const device = ((await api.get('/api/mesh/local-agents')).data as Device[]).find((entry) => entry.id === machineId);
    assert.ok(device, `this computer, ${machineId}, is not among the owner's machines`);
    await page.goto(`${devKoalaPage}/#/mesh`);
    const row = page.locator('div.rounded-2xl', { hasText: device.name }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText('online', { exact: true })).toBeVisible();
    await expect(row.getByText(/^GPUs: 2 × .+ GiB each$/)).toBeVisible();
    await expect(row.getByText(/not usable yet|could not be read/)).toHaveCount(0);
    const gpusOnMyMachines = await row.getByText(/^GPUs:/).innerText();
    const cluster = ((await api.get('/api/clusters')).data as Cluster[]).find((entry) => entry.id === clusterId);
    assert.ok(cluster, `${clusterId} is not among the owner's clusters`);
    await page.goto(`${devKoalaPage}/#/infrastructure`);
    const card = page.getByTestId('cluster-card').filter({ hasText: cluster.name });
    await expect(card.getByText(/^GPUs: 2 × .+ GiB each$/)).toBeVisible({ timeout: 60_000 });
    await expect(card.getByText(/not usable yet|could not be read/)).toHaveCount(0);
    const contents = (await api.get(`/api/infrastructure/clusters/${clusterId}`)).data as { workloads: Array<{ namespace: string; name: string; group: string }>; services?: Array<{ id: string; state: string }> };
    const koalasOwn = contents.workloads.filter((workload) => workload.namespace === DEV_NAMESPACE);
    assert.ok(koalasOwn.length > 0, `the cluster page lists none of Koala's own pods in ${DEV_NAMESPACE}`);
    assert.deepEqual(koalasOwn.filter((workload) => workload.group !== 'platform').map((workload) => `${workload.name} (${workload.group})`), [], 'Koala\'s own pods are listed as something other than the platform');
    console.log(`  ${device.name} online; ${gpusOnMyMachines}, on My Machines and its cluster card`);
    nothingWentWrong(watching, 'My Machines and the cluster card');

    step('no app on this machine asks for its GPUs before the suite deploys, as a reset leaves it');
    await noAppHoldsAGpu(api, clusterId);
    console.log('  none does');

    await serves(VLLM);
    await serves(TABBY);
  } catch (err) {
    if (watching) {
      const shot = `${process.env.V1_LIVE_SHOTS ?? '/tmp'}/v1-live-${Date.now()}.png`;
      await watching.page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      console.error(`\n── the page at ${watching.page.url()} (screenshot ${shot}) ──\n${(await watching.page.locator('body').innerText().catch(() => '')).slice(0, 2000)}`);
      console.error(`── what the page reported ──\n${watching.problems.join('\n')}`);
    }
    throw err;
  } finally {
    stopWatching();
    await browser.close();
    if (deploymentId) {
      const gone = await api.delete(`/api/deployments/${deploymentId}`);
      console.log(`  ${current} destroyed after the failure: ${gone.status}`);
      await until(`${current} gone`, async () => ((await mine(api)).some((entry) => entry.id === deploymentId) ? undefined : true), async () => {
      const found = (await mine(api)).find((entry) => entry.id === deploymentId);
      return found?.status === 'failed' ? `destroying it failed: ${String(found.failure ?? 'and its record says no reason')}` : undefined;
    });
    }
    const restored = await api.put('/api/models/default', { modelId: previousDefault });
    console.log(restored.status === 200 ? `  the default is back to ${previousDefault ?? 'none'}` : `  THE DEFAULT COULD NOT BE PUT BACK to ${previousDefault}: ${JSON.stringify(restored.data)}`);
    for (const id of chats.madeIds()) for await (const workflow of temporal.client.workflow.list({ query: `WorkflowId STARTS_WITH "memory-conversation-${id.replace(/[^A-Za-z0-9_-]+/g, '-')}-"` })) runIds.add(workflow.workflowId);
    await chats.removeMade(async (id) => { await api.delete(`/api/conversations/${id}`); });
    await forgetWhatRunsLeft(db, owner.id, new Set([...runIds, ...[...runIds].map((id) => `memory-run-${id}`)]));
    await temporal.close();
    await db.close?.();
  }
  step('the stack is as the suite found it: every conversation there before untouched, the default model back');
  await chats.untouched();
  const defaultNow = ((await api.get('/api/models/default')).data as { defaultModelId: string | null }).defaultModelId;
  assert.equal(defaultNow, previousDefault, `the default model is ${defaultNow}, not ${previousDefault ?? 'none'} as before`);
  console.log('  untouched');
  console.log('\nv1 live — PASS');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
