import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { ClusterMetadata } from '../../platform/lib/types.js';
import { encryptValue } from '../../platform/lib/crypto.js';
import { startAppDeploy, type AppDeployDeps } from './AppDeploy.js';
import { testClusterAccess } from '../testing/cluster-access.js';
import { chatTemplatesOverHttp, seedToolCallParsers, ToolCallParsers } from '../../models/index.js';
import { startHuggingFaceStandIn, type HuggingFaceStandIn } from '../../models/testing/hugging-face-stand-in.js';
import { savedHuggingFaceTokenOf } from './hugging-face-token.js';

const KEY = 'test-key-that-is-at-least-32-characters-long';

let hf: HuggingFaceStandIn;
beforeAll(async () => {
  hf = await startHuggingFaceStandIn({
    'Qwen/Qwen3-8B': { fixture: 'Qwen/Qwen3-8B', as: 'tokenizer_config.json' },
    'meta-llama/Llama-3.2-3B-Instruct': { fixture: 'meta-llama/Llama-3.2-3B-Instruct' },
    'someone/their-own-model': { template: '{% for message in messages %}{{ message.content }}{% endfor %}' },
  });
});
afterAll(async () => { await hf.close(); });

const CLUSTER: ClusterMetadata = { id: 'c1', name: 'shared', provider: 'machine', machineId: 'dev2', status: 'healthy', capacity: { cpuCores: 16, ramGb: 64 }, gpus: [{ vendor: 'nvidia', model: 'RTX 3090', memoryMiB: 24576, count: 2, runtime: true }] } as ClusterMetadata;

async function deps(): Promise<{ deps: AppDeployDeps; started: { workflowId: string; args: Record<string, unknown> }[] }> {
  const db = await testDatabase();
  await db.infrastructure.saveCluster(CLUSTER);
  await seedToolCallParsers(db.models);
  const started: { workflowId: string; args: Record<string, unknown> }[] = [];
  const start = vi.fn(async (_workflow: unknown, options: { workflowId: string; args: [Record<string, unknown>] }) => {
    started.push({ workflowId: options.workflowId, args: options.args[0] });
    return {};
  });
  return {
    deps: {
      db,
      client: () => ({ workflow: { start } }) as never,
      masterKey: KEY as never,
      clusterById: async (id) => (id === CLUSTER.id ? CLUSTER : undefined),
      handOver: (clusterId) => testClusterAccess(db).handOver(clusterId),
      logDir: '/tmp',
      toolCalling: new ToolCallParsers({ store: db.models, templates: chatTemplatesOverHttp(hf.url), savedToken: savedHuggingFaceTokenOf(db.accounts, KEY as never) }),
    },
    started,
  };
}

describe('two people can each have an app called shop', () => {
  it('gives each owner their own record, id and namespace on the same cluster', async () => {
    const { deps: d, started } = await deps();
    const ann = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'ann');
    const bob = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'bob');

    expect(ann.deployment.id).not.toBe('shop');
    expect(ann.deployment.id).not.toBe(bob.deployment.id);
    expect(ann.deployment.namespace).toMatch(/^shop-[a-f0-9]{6}$/);
    expect(bob.deployment.namespace).toMatch(/^shop-[a-f0-9]{6}$/);
    expect(ann.deployment.namespace).not.toBe(bob.deployment.namespace);

    const saved = await d.db.infrastructure.getDeployments();
    expect(saved.map((dep) => [dep.ownerId, dep.name, dep.namespace]).sort()).toEqual([
      ['ann', 'shop', ann.deployment.namespace],
      ['bob', 'shop', bob.deployment.namespace],
    ]);
    expect(started.map((run) => run.args.namespace)).toEqual([ann.deployment.namespace, bob.deployment.namespace]);
    expect(started[0]!.args).toMatchObject({ clusterId: 'c1', machine: { deviceId: 'dev2' } });
  });

  it('deploying the same app again as its owner reuses the record, not another owner\'s', async () => {
    const { deps: d } = await deps();
    const first = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'ann');
    await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'bob');
    const again = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'ann');

    expect(again.deployment.id).toBe(first.deployment.id);
    expect(again.deployment.namespace).toBe(first.deployment.namespace);
    expect((await d.db.infrastructure.getDeployments()).length).toBe(2);
  });

  it('the database refuses one owner two apps of one name and allows two owners one each', async () => {
    const { deps: d } = await deps();
    await d.db.infrastructure.saveDeployment({ id: 'a', name: 'shop', clusterId: 'c1', strategy: 'helm', status: 'running', ownerId: 'ann' });
    await d.db.infrastructure.saveDeployment({ id: 'b', name: 'shop', clusterId: 'c2', strategy: 'helm', status: 'running', ownerId: 'bob' });
    await expect(d.db.infrastructure.saveDeployment({ id: 'c', name: 'shop', clusterId: 'c2', strategy: 'helm', status: 'running', ownerId: 'ann' }))
      .rejects.toThrow(/duplicate key/);
  });

  it('stores a new app under the cluster\'s own id, however the request named it', async () => {
    const { deps: d } = await deps();
    const named = await startAppDeploy({ ...d, clusterById: async (id) => (id === 'by-another-name' || id === CLUSTER.id ? CLUSTER : undefined) }, { name: 'blog', clusterId: 'by-another-name', appType: 'wordpress' });
    expect((await d.db.infrastructure.getDeployments()).find((entry) => entry.id === named.deployment.id)?.clusterId).toBe('c1');
  });
});

describe('a model\'s Hugging Face token', () => {
  it('is the one given with the deploy, else the person\'s saved token read back from the database, else none', async () => {
    const { deps: d, started } = await deps();
    await d.db.accounts.saveUser({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: 'x', credentials: { huggingface: { hfToken: encryptValue('hf_saved', d.masterKey) } } });
    await d.db.accounts.saveUser({ id: 'bob', email: 'bob@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: 'x' });
    await startAppDeploy(d, { name: 'given', clusterId: 'c1', appType: 'vllm', vllmGpuCount: 1, vllmHfToken: 'hf_given' }, 'ann');
    await startAppDeploy(d, { name: 'saved', clusterId: 'c1', appType: 'tabbyapi', tabbyGpuCount: 1 }, 'ann');
    await startAppDeploy(d, { name: 'none', clusterId: 'c1', appType: 'vllm', vllmGpuCount: 1 }, 'bob');

    expect(started.map((run) => [run.args.vllmHfToken, run.args.tabbyHfToken])).toEqual([['hf_given', undefined], [undefined, 'hf_saved'], [undefined, undefined]]);
    expect(hf.asked.filter((ask) => ask.path.startsWith('/meta-llama/')).map((ask) => ask.token)).toEqual(['hf_given', undefined]);
    const stored = Object.fromEntries((await d.db.infrastructure.getDeployments()).map((dep) => [dep.name, [dep.vllmHfToken, dep.tabbyHfToken]]));
    expect(stored).toEqual({ given: ['hf_given', undefined], saved: [undefined, 'hf_saved'], none: [undefined, undefined] });
  });
});

describe('a vLLM deploy\'s tool calling, as the database keeps it', () => {
  it('is stored on, with the parser chosen from the model\'s chat template, and refused with nothing stored for a template with no format Koala knows', async () => {
    const { deps: d, started } = await deps();
    await startAppDeploy(d, { name: 'qwen', clusterId: 'c1', appType: 'vllm', vllmGpuCount: 1, vllmModel: 'Qwen/Qwen3-8B' }, 'ann');
    await expect(startAppDeploy(d, { name: 'odd', clusterId: 'c1', appType: 'vllm', vllmGpuCount: 1, vllmModel: 'someone/their-own-model' }, 'ann')).rejects.toThrow(/has no tool call format Koala knows: pick a parser, or turn tool calling off/);
    expect(started.map((run) => [run.args.vllmToolCallingEnabled, run.args.vllmToolCallParser])).toEqual([[true, 'hermes']]);
    expect((await d.db.infrastructure.getDeployments()).map((dep) => [dep.name, dep.vllmToolCallingEnabled, dep.vllmToolCallParser])).toEqual([['qwen', true, 'hermes']]);
  });
});

describe('a deploy asking for GPUs, decided by what the machine reported', () => {
  const DESK: ClusterMetadata = { id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'stopped', capacity: { cpuCores: 16, ramGb: 64, gpuCount: 2, gpuVendor: 'nvidia' }, gpus: [{ vendor: 'nvidia', model: 'RTX 3090', memoryMiB: 24576, count: 2, runtime: true }] } as ClusterMetadata;
  const onDesk = async () => {
    const made = await deps();
    await made.deps.db.infrastructure.saveCluster(DESK);
    return { ...made, deps: { ...made.deps, clusterById: async (id: string) => (id === DESK.id ? DESK : undefined) } };
  };

  it('refuses more GPUs than the machine has, and a model app that names no count, recording and starting nothing', async () => {
    const { deps: d, started } = await onDesk();
    await expect(startAppDeploy(d, { name: 'big', clusterId: DESK.id, appType: 'vllm', vllmGpuCount: 3 }, 'ann')).rejects.toThrow(/asks for 3 NVIDIA GPUs, and .* has 2 NVIDIA GPUs\. Ask for 2 or fewer\./);
    await expect(startAppDeploy(d, { name: 'unsaid', clusterId: DESK.id, appType: 'vllm' }, 'ann')).rejects.toThrow(/GPU/);
    expect(started).toEqual([]);
    expect((await d.db.infrastructure.getDeployments()).map((dep) => dep.name)).toEqual([]);
  });

  it('takes one GPU on the machine, recording the vendor it reported', async () => {
    const { deps: d, started } = await onDesk();
    await startAppDeploy(d, { name: 'small', clusterId: DESK.id, appType: 'vllm', vllmGpuCount: 1 }, 'ann');
    expect(started.map((run) => [run.args.vllmGpuCount, run.args.vllmGpuVendor])).toEqual([[1, 'nvidia']]);
  });

  it('refuses a GPU app on a cluster not known here, and an app recorded with no type deployed again, recording and starting nothing new', async () => {
    const { deps: d, started } = await onDesk();
    await expect(startAppDeploy(d, { name: 'lost', clusterId: 'machine-gone', appType: 'vllm', vllmGpuCount: 1 }, 'ann')).rejects.toThrow('This app asks for GPUs, and the cluster machine-gone is not known here.');
    await d.db.infrastructure.saveDeployment({ id: 'untyped', name: 'old', clusterId: DESK.id, strategy: 'native', status: 'failed', ownerId: 'ann' });
    await expect(startAppDeploy(d, { name: 'old', clusterId: DESK.id }, 'ann')).rejects.toThrow('old has no app type recorded, so it cannot be deployed again: remove it and deploy it anew');
    expect(started).toEqual([]);
    expect((await d.db.infrastructure.getDeployments()).map((dep) => dep.name)).toEqual(['old']);
  });
});

