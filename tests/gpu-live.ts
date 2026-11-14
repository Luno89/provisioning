import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import axios, { type AxiosInstance } from 'axios';
import { madeHere } from './lib/made-here.js';
import { devKoalaApi, devKoalaEnv, devKubectl, devKubectlCluster, devOwner, devPortForward } from './lib/dev-stack.js';
import { describeStopped, startOwnersModels, stopOwnersModels, type StoppedModel } from './lib/owner-models.js';

const NAME = `gpu-${Date.now().toString(36)}`;
const MODEL = 'Qwen/Qwen2.5-0.5B-Instruct';
const LOCAL_PORT = 19123;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Deployment { id: string; name: string; clusterId: string; appType?: string; namespace?: string; status: string; vllmGpuCount?: number; tabbyGpuCount?: number; [field: string]: unknown }
interface Gpu { vendor: string; model: string; memoryMiB: number; count: number; runtime: boolean }
interface Cluster { id: string; name: string; gpus?: Gpu[]; gpuProblems?: string[] }
interface Node { status: { allocatable: Record<string, string>; images?: { names: string[]; sizeBytes: number }[] } }

let stageCount = 0;
async function stage<T>(name: string, work: () => Promise<T>): Promise<T> {
  stageCount += 1;
  const started = Date.now();
  console.log(`[${stageCount}] ${name}`);
  try {
    const value = await work();
    console.log(`    ok (${Math.round((Date.now() - started) / 1000)}s)`);
    return value;
  } catch (err) {
    console.log(`    FAILED at "${name}": ${(err as Error).message}`);
    throw err;
  }
}

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
    if (tries > 0 && tries % 12 === 0) console.log(`    still waiting for ${what}${last ? ` (${last.slice(0, 200)})` : ''}`);
    await sleep(5000);
  }
}

const client = (cookie: string): AxiosInstance => axios.create({ baseURL: devKoalaApi, proxy: false, maxRedirects: 0, headers: { Cookie: cookie }, validateStatus: () => true });
const mine = async (api: AxiosInstance): Promise<Deployment[]> => (await api.get('/api/deployments')).data as Deployment[];
const nodes = async (): Promise<Node[]> => (JSON.parse(await devKubectlCluster('get', 'nodes', '-o', 'json')) as { items: Node[] }).items;
const vllmImages = async (): Promise<string[]> => (await nodes()).flatMap((node) => node.status.images ?? []).filter((image) => image.names.some((name) => name.includes('vllm/vllm-openai'))).map((image) => `${image.names.find((name) => !name.includes('@')) ?? image.names[0]} (${Math.round(image.sizeBytes / 1e9)} GB)`);

async function main(): Promise<void> {
  const owner = await devOwner();
  const api = client(owner.cookie);
  const machine = devKoalaEnv().INSTANCE_MACHINE_ID;
  assert.ok(machine, 'dev\'s Koala names no INSTANCE_MACHINE_ID, so it runs on no machine of its own');
  const clusterId = `machine-${machine}`;
  const apps = madeHere<Deployment>({ name: 'deployments', list: () => mine(api), idOf: (app) => app.id, stampOf: () => undefined });
  await apps.before();
  const stopped: StoppedModel[] = [];
  let id: string | undefined;
  let forward: ChildProcess | undefined;

  try {
    const reported = await stage(`the machine Koala runs on, ${clusterId}, reports its NVIDIA GPUs, with the container toolkit there`, async () => {
      const cluster = await until('the machine\'s GPU report', async () => {
        const found = ((await api.get('/api/clusters')).data as Cluster[]).find((entry) => entry.id === clusterId);
        if (!found) throw new Hopeless(`${clusterId} is not among the owner's clusters`);
        return found.gpus ? found : undefined;
      });
      const nvidia = (cluster.gpus ?? []).filter((gpu) => gpu.vendor === 'nvidia');
      console.log(`    ${nvidia.map((gpu) => `${gpu.count} × ${gpu.model} (${gpu.memoryMiB} MiB, toolkit ${gpu.runtime ? 'there' : 'missing'})`).join(', ')}${cluster.gpuProblems?.length ? `; problems: ${cluster.gpuProblems.join('; ')}` : ''}`);
      assert.deepEqual(cluster.gpuProblems ?? [], [], 'the machine had problems reading its GPUs');
      const usable = nvidia.filter((gpu) => gpu.runtime).reduce((sum, gpu) => sum + gpu.count, 0);
      assert.equal(usable, 2, 'the machine does not report its two NVIDIA GPUs as usable');
      return usable;
    });

    await stage('a deploy asking for more GPUs than the machine has is refused, with what to do, before anything is made', async () => {
      const refused = await api.post('/api/deployments', { name: `${NAME}-too-many`, clusterId, appType: 'vllm', strategy: 'native', vllmModel: MODEL, vllmGpuCount: reported + 1 });
      console.log(`    ${refused.status}: ${JSON.stringify(refused.data)}`);
      assert.equal(refused.status, 400);
      assert.match((refused.data as { error: string }).error, new RegExp(`asks for ${reported + 1} NVIDIA GPUs, and .* has ${reported} NVIDIA GPUs\\. Ask for ${reported} or fewer\\.`));
      assert.equal((await mine(api)).some((entry) => entry.name === `${NAME}-too-many`), false, 'the refused deploy left a record');
    });

    await stage('the owner\'s own models holding GPUs on this machine are stopped for the test, their records kept', async () => {
      stopped.push(...await stopOwnersModels(api, clusterId));
      console.log(stopped.length ? `    stopped ${describeStopped(stopped)}` : '    none of the owner\'s models holds a GPU here, so none is stopped');
    });

    const imagesBefore = await vllmImages();
    const deployed = await stage(`${NAME}, vLLM serving ${MODEL} on one GPU, deploys through Koala, which readies the machine's GPUs first`, async () => {
      const made = await api.post('/api/deployments', { name: NAME, clusterId, appType: 'vllm', strategy: 'native', vllmModel: MODEL, vllmGpuCount: 1, vllmGpuMemUtil: 0.5 });
      assert.equal(made.status, 202, `the deploy answered ${made.status}: ${JSON.stringify(made.data)}`);
      id = (made.data as { id: string }).id;
      apps.made(id);
      const running = await until(`${NAME} running`, async () => {
        const found = (await mine(api)).find((entry) => entry.id === id);
        if (!found) throw new Hopeless('the deployment is gone from the list');
        if (found.status === 'failed') throw new Hopeless(`the app failed to deploy: ${String(found.failure ?? 'and its record says no reason')}`);
        return found.status === 'running' ? found : undefined;
      });
      const imagesAfter = await vllmImages();
      console.log(`    vLLM image ${imagesBefore.length ? `was already on the machine: ${imagesBefore.join(', ')}` : `was pulled this run: ${imagesAfter.join(', ')}`}`);
      return running;
    });

    await stage('the machine\'s node advertises its NVIDIA GPUs to the scheduler', async () => {
      const advertised = (await nodes()).reduce((sum, node) => sum + Number(node.status.allocatable['nvidia.com/gpu'] ?? 0), 0);
      console.log(`    nvidia.com/gpu: ${advertised}`);
      assert.equal(advertised, reported);
    });

    await stage(`the model answers through its service, from its GPU, and Koala takes the window it serves`, async () => {
      const namespace = deployed.namespace ?? NAME;
      const services = JSON.parse(await devKubectl(namespace, 'get', 'services', '-o', 'json')) as { items: { metadata: { name: string }; spec: { ports: { port: number }[] } }[] };
      const service = services.items.find((entry) => entry.spec.ports.some((port) => port.port === 8000));
      assert.ok(service, `no service on port 8000 in ${namespace}`);
      forward = devPortForward(namespace, `svc/${service.metadata.name}`, `${LOCAL_PORT}:8000`);
      const vllm = axios.create({ baseURL: `http://127.0.0.1:${LOCAL_PORT}`, proxy: false, validateStatus: () => true });
      const served = await until('the model listing its name', async () => {
        const listed = await vllm.get('/v1/models');
        return listed.status === 200 ? (listed.data as { data: { id: string }[] }).data[0]?.id : undefined;
      });
      const answer = await vllm.post('/v1/chat/completions', { model: served, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], max_tokens: 8, temperature: 0 });
      assert.equal(answer.status, 200, JSON.stringify(answer.data));
      const said = (answer.data as { choices: { message: { content: string } }[] }).choices[0]?.message.content ?? '';
      console.log(`    ${served} said: ${JSON.stringify(said)}`);
      assert.ok(said.trim().length > 0, 'the model said nothing');
      const window = ((await vllm.get('/v1/models')).data as { data: { max_model_len?: number }[] }).data[0]?.max_model_len;
      assert.ok(window, 'vLLM listed no max_model_len');
      const listed = ((await api.get('/api/models')).data as { id: string; contextTokens?: number }[]).find((entry) => entry.id === id);
      console.log(`    vLLM serves a window of ${window} tokens; Koala lists it with ${String(listed?.contextTokens)}`);
      assert.equal(listed?.contextTokens, window, 'Koala does not list the window its server serves');
      const pods = JSON.parse(await devKubectl(namespace, 'get', 'pods', '-o', 'json')) as { items: { spec: { containers: { resources?: { limits?: Record<string, string> } }[] } }[] };
      assert.equal(pods.items[0]?.spec.containers[0]?.resources?.limits?.['nvidia.com/gpu'], '1', 'the model\'s pod holds no GPU');
    });
  } finally {
    forward?.kill();
    if (id) {
      await stage(`${NAME} destroyed`, async () => {
        const gone = await api.delete(`/api/deployments/${id}`);
        if (gone.status >= 300 && gone.status !== 404) console.log(`    destroying answered ${gone.status}: ${JSON.stringify(gone.data)}`);
        await until(`${NAME} gone`, async () => ((await mine(api)).some((entry) => entry.id === id) ? undefined : true));
      });
    }
    if (stopped.length) {
      await stage('the owner\'s models are started again as they were', async () => {
        await startOwnersModels(stopped);
        console.log(`    started ${describeStopped(stopped)}`);
      });
    }
  }
  await stage('every deployment of the owner\'s from before is still there', () => apps.untouched());
  console.log('\npassed');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
