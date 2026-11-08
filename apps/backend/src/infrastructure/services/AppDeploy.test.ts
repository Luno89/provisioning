import type { WorkflowClient } from '@temporalio/client';
import { afterEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { encryptValue, type ClusterMetadata, type DeploymentMetadata, type PipelineRunMetadata, type ProjectMetadata } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { CapacityError } from '../lib/cluster-capacity.js';
import { deployProjectBuild, resolveOpenaiApiBaseUrl, startAppDeploy, type AppDeployDeps } from './AppDeploy.js';
import { ClusterUnreachable, type ClusterAccess } from './ClusterAccess.js';

const KEY = 'test-key-that-is-at-least-32-characters-long';
const CLUSTER: ClusterMetadata = { id: 'c1', name: 'shared', provider: 'k3d', status: 'healthy' } as ClusterMetadata;
const saved = { HF_TOKEN: process.env.HF_TOKEN, HUGGING_FACE_HUB_TOKEN: process.env.HUGGING_FACE_HUB_TOKEN };

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

async function deps(cluster: ClusterMetadata = CLUSTER) {
  const db = memoryDatabase();
  await db.infrastructure.saveCluster(cluster);
  const workflow = mock<Pick<WorkflowClient, 'start'>>();
  const access = mock<Pick<ClusterAccess, 'handOver'>>();
  access.handOver.mockImplementation(async (clusterId) => ({ clusterId, reach: { clusterId, kind: 'koala' } }));
  const started = () => workflow.start.mock.calls.map(([, options]) => ({ workflowId: options.workflowId, taskQueue: options.taskQueue, args: (options.args as [Record<string, unknown>])[0], memo: options.searchAttributes }));
  const all: AppDeployDeps = {
    db,
    client: () => ({ workflow }),
    masterKey: KEY,
    clusterById: async (id) => (id === cluster.id ? cluster : undefined),
    handOver: (clusterId) => access.handOver(clusterId),
    logDir: '/tmp/logs',
    claims: { role: 'combined' },
  };
  return { deps: all, db, workflow, started, access };
}

const dep = (over: Partial<DeploymentMetadata>): DeploymentMetadata => ({ id: 'd', name: 'app', clusterId: 'c1', strategy: 'helm', status: 'running', ...over });

describe('two people can each have an app called shop', () => {
  it('gives each owner their own record, id and namespace on the same cluster', async () => {
    const { deps: d, started, db } = await deps();
    const ann = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'ann');
    const bob = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'bob');
    expect(ann.deployment.id).not.toBe('shop');
    expect(ann.deployment.id).not.toBe(bob.deployment.id);
    expect(ann.deployment.namespace).toMatch(/^shop-[a-f0-9]{6}$/);
    expect(ann.deployment.namespace).not.toBe(bob.deployment.namespace);
    expect((await db.infrastructure.getDeployments()).map((saved) => [saved.ownerId, saved.name, saved.namespace]).sort()).toEqual([
      ['ann', 'shop', ann.deployment.namespace],
      ['bob', 'shop', bob.deployment.namespace],
    ]);
    expect(started().map((run) => run.args.namespace)).toEqual([ann.deployment.namespace, bob.deployment.namespace]);
  });

  it('deploying the same app again as its owner reuses the record, not another owner\'s', async () => {
    const { deps: d, db } = await deps();
    const first = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'ann');
    await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'bob');
    const again = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'ann');
    expect(again.deployment.id).toBe(first.deployment.id);
    expect(again.deployment.namespace).toBe(first.deployment.namespace);
    expect((await db.infrastructure.getDeployments()).length).toBe(2);
  });
});

describe('starting a deploy', () => {
  it('records the app as deploying with its workflow and log, and starts the workflow on the cluster queue as its owner', async () => {
    const { deps: d, db, workflow, started } = await deps();
    const { workflowId, deployment } = await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress', modules: ['seo'] }, 'ann');
    const [record] = await db.infrastructure.getDeployments();
    expect(record).toMatchObject({ id: deployment.id, status: 'deploying', temporalWorkflowId: workflowId, ownerId: 'ann', appType: 'wordpress', modules: ['seo'] });
    expect(record?.lastLogPath).toMatch(/^\/tmp\/logs\/\d+-[a-z0-9]+-C3\.log$/);
    expect(workflowId).toMatch(/^app-deploy-shop-\d+-[a-z0-9]{6}$/);
    expect(workflow.start).toHaveBeenCalledTimes(1);
    expect(started()[0]).toMatchObject({ taskQueue: 'cluster-ops-queue', args: { name: 'shop', clusterName: 'shared', provider: 'k3d', appType: 'wordpress', modules: ['seo'], deploymentId: deployment.deploymentId } });
  });

  it('hands the workflow the reach worked out for the app\'s cluster, and nothing else about reaching it', async () => {
    const { deps: d, started, access } = await deps();
    await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'ann');
    expect(access.handOver).toHaveBeenCalledWith('c1');
    expect(started()[0]?.args).toMatchObject({ clusterId: 'c1', reach: { clusterId: 'c1', kind: 'koala' } });
    expect(started()[0]?.args).not.toHaveProperty('machine');
    expect(started()[0]?.args).not.toHaveProperty('kubeconfig');
    expect(started()[0]?.args).not.toHaveProperty('clusterGpuEnabled');
  });

  it('hands a machine over as the machine to start, since its cluster may be stopped until the deploy starts it', async () => {
    const { deps: d, started, access } = await deps();
    access.handOver.mockResolvedValue({ clusterId: 'c1', machine: { deviceId: 'desk' } });
    await startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'ann');
    expect(started()[0]?.args).toMatchObject({ clusterId: 'c1', machine: { deviceId: 'desk' } });
    expect(started()[0]?.args).not.toHaveProperty('reach');
  });

  it('refuses a deploy to a cluster that cannot be reached, saying why, before it records or starts anything', async () => {
    const { deps: d, db, workflow, access } = await deps();
    access.handOver.mockRejectedValue(new ClusterUnreachable('c1', 'other-kind', 'shared is a k3d cluster, and every cluster Koala reaches is a machine\'s'));
    await expect(startAppDeploy(d, { name: 'shop', clusterId: 'c1', appType: 'wordpress' }, 'ann')).rejects.toThrow('every cluster Koala reaches is a machine\'s');
    expect(await db.infrastructure.getDeployments()).toEqual([]);
    expect(workflow.start).not.toHaveBeenCalled();
  });

  it('records a new app under the cluster\'s own id, however the request named it', async () => {
    const { deps: d } = await deps();
    const named = await startAppDeploy({ ...d, clusterById: async (id) => (id === 'provisioning-lunorica' ? CLUSTER : undefined) }, { name: 'blog', clusterId: 'provisioning-lunorica', appType: 'wordpress' });
    expect(named.deployment.clusterId).toBe(CLUSTER.id);
  });

  it('refuses a new app with no name or cluster before it records anything', async () => {
    const { deps: d, db } = await deps();
    await expect(startAppDeploy(d, { clusterId: 'c1' }, 'ann')).rejects.toThrow('a new app needs a name and a cluster to deploy to');
    expect(await db.infrastructure.getDeployments()).toEqual([]);
  });

  it('refuses an app a person starts when the cluster cannot fit it', async () => {
    const small: ClusterMetadata = { ...CLUSTER, capacity: { cpuCores: 2, ramGb: 2 } };
    const { deps: d, db, workflow } = await deps(small);
    await expect(startAppDeploy(d, { name: 'llm', clusterId: 'c1', appType: 'vllm' }, 'ann')).rejects.toBeInstanceOf(CapacityError);
    expect(await db.infrastructure.getDeployments()).toEqual([]);
    expect(workflow.start).not.toHaveBeenCalled();
  });

  it('does not check capacity for platform work started without a person', async () => {
    const small: ClusterMetadata = { ...CLUSTER, capacity: { cpuCores: 2, ramGb: 2 } };
    const { deps: d, workflow } = await deps(small);
    await startAppDeploy(d, { name: 'llm', clusterId: 'c1', appType: 'vllm' });
    expect(workflow.start).toHaveBeenCalledTimes(1);
  });

  it('finds an existing record by its id and keeps its namespace', async () => {
    const { deps: d, db, started } = await deps();
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'd1', name: 'blog', namespace: 'blog-aaaaaa', ownerId: 'ann', appType: 'wordpress' }));
    const { deployment } = await startAppDeploy(d, { id: 'd1', clusterId: 'c1' }, 'ann');
    expect(deployment.namespace).toBe('blog-aaaaaa');
    expect(started()[0]?.args.namespace).toBe('blog-aaaaaa');
    expect((await db.infrastructure.getDeployments())).toHaveLength(1);
  });

  it('deploys a project\'s image from the repository and tag of its image tag', async () => {
    const { deps: d, started } = await deps();
    await startAppDeploy(d, { name: 'books', clusterId: 'c1', appType: 'gitapp', gitappProjectId: 'p1', gitappImageTag: 'registry.local:5000/acme/books:abc123', gitappEnv: 'A=1' }, 'ann');
    expect(started()[0]?.args).toMatchObject({ odooRepo: 'registry.local:5000/acme/books', odooTag: 'abc123', gitappEnv: 'A=1' });
  });

  it('takes a repository and tag given for the app, but never Odoo\'s placeholder image over another app\'s', async () => {
    const { deps: d, db, started } = await deps();
    await startAppDeploy(d, { name: 'a', clusterId: 'c1', appType: 'wordpress', webRepo: 'bitnami/wordpress', webTag: '6' }, 'ann');
    await db.infrastructure.saveDeploymentInfo(dep({ id: 'b', name: 'b', appType: 'wordpress', ownerId: 'ann', webRepo: 'bitnami/wordpress', webTag: '6' }));
    await startAppDeploy(d, { name: 'b', clusterId: 'c1', appType: 'wordpress', odooRepo: 'library/odoo', odooTag: '17' }, 'ann');
    await startAppDeploy(d, { name: 'b', clusterId: 'c1', appType: 'wordpress', webRepo: 'bitnami/wordpress', webTag: '7' }, 'ann');
    expect(started().map((run) => [run.args.odooRepo, run.args.odooTag])).toEqual([['bitnami/wordpress', '6'], ['bitnami/wordpress', '6'], ['bitnami/wordpress', '7']]);
  });

  it('gives a model on the system cluster its cache folder on the host', async () => {
    const system: ClusterMetadata = { ...CLUSTER, isSystem: true };
    const { deps: d, started } = await deps(system);
    await startAppDeploy(d, { name: 'llm', clusterId: 'c1', appType: 'tabbyapi', tabbyCachePvc: 'models' }, 'ann');
    expect(started()[0]?.args.modelCacheHostPath).toEqual(expect.stringContaining('models'));
  });

  it('gives a model the Hugging Face token the person stored, the operator\'s from the environment, or none', async () => {
    delete process.env.HF_TOKEN;
    delete process.env.HUGGING_FACE_HUB_TOKEN;
    const { deps: d, db, started } = await deps();
    await db.accounts.saveUser({ id: 'ann', email: 'a@b.c', twoFactorEnabled: false, emailVerified: true, createdAt: 'x', credentials: { huggingface: { hfToken: encryptValue('hf_mine', KEY) } } } as never);
    await db.accounts.saveUser({ id: 'bob', email: 'b@b.c', twoFactorEnabled: false, emailVerified: true, createdAt: 'x' });
    await startAppDeploy(d, { name: 'm1', clusterId: 'c1', appType: 'vllm' }, 'ann');
    await startAppDeploy(d, { name: 'm2', clusterId: 'c1', appType: 'tabbyapi' }, 'ann');
    await startAppDeploy(d, { name: 'm3', clusterId: 'c1', appType: 'vllm' }, 'bob');
    process.env.HF_TOKEN = 'hf_operator';
    await startAppDeploy(d, { name: 'm4', clusterId: 'c1', appType: 'vllm' });
    expect(started().map((run) => [run.args.vllmHfToken, run.args.tabbyHfToken])).toEqual([['hf_mine', undefined], [undefined, 'hf_mine'], [undefined, undefined], ['hf_operator', undefined]]);
  });

  it('keeps the token it was given rather than looking one up', async () => {
    const { deps: d, started } = await deps();
    process.env.HF_TOKEN = 'hf_operator';
    await startAppDeploy(d, { name: 'm1', clusterId: 'c1', appType: 'vllm', vllmHfToken: '  hf_given  ' }, 'ann');
    expect(started()[0]?.args.vllmHfToken).toBe('hf_given');
  });
});

describe('resolveOpenaiApiBaseUrl', () => {
  const vllm = dep({ id: 'v', name: 'My Model', appType: 'vllm' });
  const tabby = dep({ id: 't', name: 'Tabby 1', appType: 'tabbyapi' });

  it('points Open WebUI and Hermes at the model on the same cluster named, by its in-cluster address', () => {
    expect(resolveOpenaiApiBaseUrl(dep({ appType: 'openwebui', openWebuiTargetId: 'v' }), [vllm])).toBe('http://my-model-vllm.my-model.svc.cluster.local:8000/v1');
    expect(resolveOpenaiApiBaseUrl(dep({ appType: 'hermes', hermesTargetId: 't' }), [tabby])).toBe('http://tabby-1-tabbyapi.tabby-1.svc.cluster.local:5000/v1');
  });

  it('points at nothing when there is no target, it is gone, on another cluster, or not a model server', () => {
    const warn = (resolve: () => string | undefined) => resolve();
    expect(resolveOpenaiApiBaseUrl(dep({ appType: 'openwebui' }), [vllm])).toBeUndefined();
    expect(resolveOpenaiApiBaseUrl(dep({ appType: 'wordpress', openWebuiTargetId: 'v' }), [vllm])).toBeUndefined();
    expect(resolveOpenaiApiBaseUrl(dep({ appType: 'openwebui', openWebuiTargetId: 'missing' }), [vllm])).toBeUndefined();
    expect(resolveOpenaiApiBaseUrl(dep({ appType: 'openwebui', openWebuiTargetId: 'x' }), [dep({ id: 'x', appType: 'wordpress' })])).toBeUndefined();
    expect(warn(() => resolveOpenaiApiBaseUrl(dep({ appType: 'openwebui', openWebuiTargetId: 'v', clusterId: 'other' }), [vllm]))).toBeUndefined();
  });
});

describe('deployProjectBuild', () => {
  const project = { id: 'p1', name: 'books', ownerId: 'ann', targetClusterId: 'c1', deployEnv: 'MODE=prod' } as unknown as ProjectMetadata;
  const run = { id: 'run-1', projectId: 'p1', commitSha: 'abc', imageTag: 'registry.local:5000/acme/books:abc123', status: 'succeeded', startedAt: 'x' } as unknown as PipelineRunMetadata;

  it('deploys a built image as the project\'s app and records which deployment promoted it', async () => {
    const { deps: d, db, started } = await deps();
    await db.releases.savePipelineRunInfo(run);
    const { deployment } = await deployProjectBuild(d, project, run);
    expect(deployment).toMatchObject({ name: 'books', appType: 'gitapp', strategy: 'native', gitappProjectId: 'p1', gitappImageTag: run.imageTag, ownerId: 'ann' });
    expect(started()[0]?.args).toMatchObject({ gitappEnv: 'MODE=prod', odooRepo: 'registry.local:5000/acme/books', odooTag: 'abc123' });
    const [promoted] = await db.releases.getPipelineRuns();
    expect(promoted).toMatchObject({ id: 'run-1', deploymentId: deployment.id });
    expect(promoted?.promotedAt).toBeTruthy();
  });

  it('refuses a run with no image and a project with no cluster', async () => {
    const { deps: d } = await deps();
    await expect(deployProjectBuild(d, project, { ...run, imageTag: undefined } as unknown as PipelineRunMetadata)).rejects.toThrow('Pipeline run has no built image to promote');
    await expect(deployProjectBuild(d, { ...project, targetClusterId: undefined } as unknown as ProjectMetadata, run)).rejects.toThrow('Project has no target cluster configured');
  });
});
