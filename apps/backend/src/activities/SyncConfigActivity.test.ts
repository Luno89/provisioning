import { records } from './testing/recorded-database.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowClient } from '@temporalio/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { ClusterAccess, ClusterService, InfrastructureService, Reach } from '../infrastructure/index.js';
import { startAppDeploy } from '../infrastructure/services/AppDeploy.js';
import { TemporalBridge } from '../infrastructure/services/TemporalBridge.js';
import type { AppSettings, ClusterMetadata, DeploymentMetadata } from '../platform/index.js';
import { memoryDatabase } from '../platform/testing/memory-database.js';
import { testDataDir } from '../platform/testing/data-dir.js';
import type { ToolCallParsers } from '../models/index.js';
import type { DeployAppArgs } from './DeployAppActivity.js';
import type { SyncConfigArgs } from './SyncConfigActivity.js';
import { answerAsACluster, stepsOn } from './testing/answering-cluster.js';

const { DeployAppActivity } = await import('./DeployAppActivity.js');
const { SyncConfigActivity } = await import('./SyncConfigActivity.js');

const KEY = 'sync-config-activity-test-key-of-32-chars';
const DESK: Reach = { clusterId: 'machine-desk', kind: 'machine', kubeconfig: 'apiVersion: v1\nkind: Config\n' };
const CLUSTER: ClusterMetadata = { id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'healthy', ownerId: 'ann', capacity: { cpuCores: 16, ramGb: 64 } };
const LOG = join(mkdtempSync(join(tmpdir(), 'sync-config-')), 'run.log');

const EVERY_SETTING = {
  vllmModel: 'org/vllm-model', vllmGpuCount: 2, vllmGpuVendor: 'amd', vllmCachePvc: 'vllm-cache', vllmHfToken: 'vllm-token',
  vllmMaxModelLen: 8192, vllmGpuMemUtil: 0.85, vllmExtraArgs: '--seed 7', vllmToolCallingEnabled: true, vllmToolCallParser: 'hermes',
  vllmServedModelName: 'served', vllmMaxNumSeqs: 12, vllmDtype: 'half', vllmEnablePrefixCaching: true,
  tabbyModel: 'org/tabby-model', tabbyRevision: 'rev-1', tabbyGpuCount: 3, tabbyHfToken: 'tabby-token', tabbyCachePvc: 'tabby-cache',
  tabbyImageTag: 'tabby-tag', tabbyCacheMode: 'Q6', tabbyMaxSeqLen: 16384, tabbyMaxBatchSize: 5, tabbyReasoning: true,
  tabbyToolFormat: 'harmony', tabbyInlineModelLoading: true, tabbyDisableAuth: false, tabbyMemoryLimit: '40G', tabbyShmSize: '8Gi',
  tabbyCpuLimit: '6', tabbyExtraEnv: 'A=1',
  searxngSecretKey: 'searxng-key', searxngEngines: 'duckduckgo', crawl4aiApiToken: 'crawl-token', crawl4aiMemoryLimit: '3Gi', crawl4aiShmSize: '1Gi',
  minioRootUser: 'minio-user', minioRootPassword: 'minio-password', nextcloudAdminPassword: 'nc-admin', nextcloudDbPassword: 'nc-db',
  nextcloudDbRootPassword: 'nc-root', hermesDashboardPassword: 'hermes-password', minioStorage: '30Gi',
  verdaccioUpstream: 'https://registry.npmjs.org/', verdaccioStorage: '9Gi',
  gitappEnv: 'GITHUB_TOKEN=abc', webuiEnableWebSearch: false, webuiWebSearchEngine: 'brave', webuiWebSearchApiKey: 'brave-key',
  appSettings: { theme: 'dark' },
} satisfies Required<AppSettings>;

const APP: DeploymentMetadata = {
  id: 'blog', name: 'blog', namespace: 'blog-1a2b3c', clusterId: 'machine-desk', ownerId: 'ann', strategy: 'native', appType: 'wordpress',
  status: 'running', deploymentId: 'blog1a2b', webRepo: 'library/wordpress', webTag: '6', storage: {}, ...EVERY_SETTING,
};

let access: MockProxy<ClusterAccess>;
let infra: MockProxy<InfrastructureService>;

const steps = () => stepsOn(access, infra, KEY);

async function handedToTheWorkflow(start: (workflow: MockProxy<Pick<WorkflowClient, 'start' | 'getHandle'>>) => Promise<unknown>): Promise<Record<string, unknown>> {
  const workflow = mock<Pick<WorkflowClient, 'start' | 'getHandle'>>();
  workflow.start.mockResolvedValue(mock<Awaited<ReturnType<WorkflowClient['start']>>>());
  workflow.getHandle.mockReturnValue(mock<ReturnType<WorkflowClient['getHandle']>>({ result: () => new Promise(() => undefined) }));
  await start(workflow);
  const [, options] = workflow.start.mock.calls.at(-1)!;
  return { ...(options.args as [Record<string, unknown>])[0], logFile: LOG };
}

async function deployed(): Promise<Record<string, unknown>> {
  const db = memoryDatabase();
  await db.infrastructure.saveCluster(CLUSTER);
  await db.infrastructure.saveDeploymentInfo(APP);
  return handedToTheWorkflow((workflow) => startAppDeploy({
    db, client: () => ({ workflow }), masterKey: KEY, logDir: testDataDir(),
    clusterById: async (id) => (id === CLUSTER.id ? CLUSTER : undefined),
    handOver: async (clusterId) => ({ clusterId, reach: DESK }),
    toolCalling: mock<Pick<ToolCallParsers, 'decide'>>(),
  }, { id: APP.id, clusterId: APP.clusterId }, 'ann'));
}

async function synced(): Promise<Record<string, unknown>> {
  const db = memoryDatabase();
  await db.infrastructure.saveCluster(CLUSTER);
  await db.infrastructure.saveDeploymentInfo(APP);
  const clusterAccess = mock<ClusterAccess>();
  clusterAccess.handOver.mockResolvedValue({ clusterId: DESK.clusterId, reach: DESK });
  const clusterService = mock<ClusterService>();
  Object.assign(clusterService, { access: clusterAccess });
  clusterService.isKoalasCluster.calledWith('machine-desk').mockReturnValue(true);
  clusterService.ownCluster.mockResolvedValue(CLUSTER as never);
  return handedToTheWorkflow(async (workflow) => {
    const bridge = new TemporalBridge(db, testDataDir(), undefined, KEY, clusterService);
    bridge.client = mock({ workflow }) as never;
    await bridge.syncConfig(APP.id);
  });
}

const stackInputs = () => infra.deploy.mock.calls.find(([stack]) => stack.startsWith('app-'))![1]!.env as Record<string, string>;

beforeEach(async () => {
  records.db = memoryDatabase();
  await records.db.infrastructure.saveCluster(CLUSTER);
  access = mock<ClusterAccess>();
  infra = mock<InfrastructureService>();
  answerAsACluster(access);
  infra.deploy.mockResolvedValue({ stdout: '', logFile: LOG });
});

describe('a config sync of an app', () => {
  it('hands the app\'s stack every setting a deploy of the same app hands it', async () => {
    await DeployAppActivity(await deployed() as unknown as DeployAppArgs, steps());
    const onDeploy = stackInputs();
    infra.deploy.mockClear();
    await SyncConfigActivity(await synced() as unknown as SyncConfigArgs, steps());
    const onSync = stackInputs();

    const dropped = Object.keys(onDeploy).filter((name) => onSync[name] !== onDeploy[name]);
    expect(dropped, `a sync hands the stack these differently from a deploy: ${dropped.map((name) => `${name} (deploy ${JSON.stringify(onDeploy[name])}, sync ${JSON.stringify(onSync[name])})`).join(', ')}`).toEqual([]);
    expect(onSync).toEqual(onDeploy);
  });
});
