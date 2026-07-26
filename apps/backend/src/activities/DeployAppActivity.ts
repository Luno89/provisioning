/**
 * DeployAppActivity
 *
 * Runs the deployment pipeline: builds a custom image if modules are selected,
 * imports it into the cluster (for k3d), then CDKTF-deploys the app stack.
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

import { InfrastructureService } from '../services/InfrastructureService.js';
import type { Database } from '../lib/db-interface.js';
import { BuilderService } from '../services/BuilderService.js';
import { StorageAdapter } from '../services/StorageAdapter.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider, isSelfManagedCluster } from '../lib/cluster-topology.js';
import { buildAppEnv } from '../lib/app-env.js';
import { GiteaService } from '../services/GiteaService.js';

export interface DeployAppArgs {
  name: string;
  clusterId: string;
  clusterName: string;
  provider: string;
  strategy: string;
  appType: string;
  clusterGpuEnabled?: boolean | undefined;
  modules?: string[] | undefined;
  odooRepo: string;
  odooTag: string;
  dbRepo: string;
  dbTag: string;
  logFile: string;
  deploymentId?: string | undefined;
  vllmModel?: string | undefined;
  vllmGpuCount?: number | undefined;
  vllmGpuVendor?: 'nvidia' | 'amd' | undefined;
  vllmCachePvc?: string | undefined;
  vllmHfToken?: string | undefined;
  vllmMaxModelLen?: number | undefined;
  vllmGpuMemUtil?: number | undefined;
  vllmExtraArgs?: string | undefined;
  vllmToolCallingEnabled?: boolean | undefined;
  vllmToolCallParser?: string | undefined;
  vllmServedModelName?: string | undefined;
  vllmMaxNumSeqs?: number | undefined;
  vllmDtype?: string | undefined;
  vllmEnablePrefixCaching?: boolean | undefined;
  tabbyModel?: string | undefined;
  tabbyRevision?: string | undefined;
  tabbyGpuCount?: number | undefined;
  tabbyHfToken?: string | undefined;
  tabbyCachePvc?: string | undefined;
  tabbyImageTag?: string | undefined;
  tabbyCacheMode?: string | undefined;
  tabbyMaxSeqLen?: number | undefined;
  tabbyMaxBatchSize?: number | undefined;
  tabbyReasoning?: boolean | undefined;
  tabbyToolFormat?: string | undefined;
  tabbyInlineModelLoading?: boolean | undefined;
  tabbyDisableAuth?: boolean | undefined;
  tabbyExtraEnv?: string | undefined;
  // Set only by TemporalBridge.deploy() for clusters where the worker shares a filesystem with
  // the K8s node (see DownloadModelActivity.ts) — AppDeployWorkflow.ts uses this to decide
  // whether to pre-download the model before this activity ever runs. Not read here; DeployAppActivity
  // itself is unaffected either way since the pod's own in-container download logic is
  // idempotent — it just sees the cache already populated when this ran first.
  modelCacheHostPath?: string | undefined;
  openaiApiBaseUrl?: string | undefined;
  webuiEnableWebSearch?: boolean | undefined;
  webuiWebSearchEngine?: string | undefined;
  webuiWebSearchApiKey?: string | undefined;
}

export interface DeployAppResult {
  status: string;
  msg: string;
  displayUrl: string;
}

// Moved to lib/activity-timeouts.ts — see that file for why (workflow files must never import a
// VALUE from an activity file, only `import type`).
export { deployAppActivityMeta } from '../lib/activity-timeouts.js';

const SANITIZE = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const LIVE_ROOT = process.cwd();

export async function DeployAppActivity(
  args: DeployAppArgs,
): Promise<DeployAppResult> {
  const infra = new InfrastructureService();
  // BuilderService inherits a Database from BaseService but never reads it — only its
  // InfrastructureService is used. Activities have no DB access by design (see TemporalBridge's
  // note on masterKey), so there is no real one to pass; the cast makes that explicit rather than
  // relying on `{}` silently satisfying an unchecked parameter.
  const builder = new BuilderService({} as unknown as Database, infra);
  const logFile = args.logFile;
  const sanitizedName = SANITIZE(args.name);

  let finalOdooRepo = args.odooRepo || (args.appType === 'odoo' ? 'library/odoo' : '');
  let finalOdooTag = args.odooTag || (args.appType === 'odoo' ? '18.0' : '');

  // 'remote' is never a mock-cloud k3d scenario — see ProvisionClusterActivity.ts /
  // ClusterService.isMockCloud() for the full explanation. hasCloudCredentials() has no 'remote'
  // case and always resolves to mode 'mock', which — before this exclusion — made every app
  // deployed onto a 'remote' cluster compute physicalName as `mock-remote-<clusterName>`, a stack
  // name CDKTF never actually created, breaking every deploy onto a real remote cluster.
  const isMock = isMockCloudProvider(args.provider, hasCloudCredentials);
  const physicalName = isMock ? `mock-${args.provider}-${args.clusterName}` : args.clusterName;

  let customImageTag: string | undefined;

  // 'remote' clusters (ProvisionRemoteHostActivity) write their own standalone kubeconfig to
  // this exact /tmp/kubeconfig-<name> path too — the LIVE_ROOT/.kube/config fallback below is
  // only meaningful for real cloud providers (aws/gcp/azure/do) that configure a system
  // kubeconfig via their own CLI tooling, which 'remote' never does. Confirmed live: without this,
  // every app deploy onto a 'remote' cluster failed with "'config_path' refers to an invalid
  // path" since that file never exists.
  const kubeconfigPath = isSelfManagedCluster(args.provider, isMock)
    ? `/tmp/kubeconfig-${physicalName}`
    : path.join(LIVE_ROOT, '.kube/config');

  // ── 1. For vLLM on k3d: verify GPU toolkit and install device plugin ──
  let effectiveDevice = process.env.VLLM_DEVICE || (args.vllmGpuCount === 0 ? 'cpu' : (args.vllmGpuVendor === 'amd' ? 'rocm' : 'cuda'));
  let effectiveGpuCount = args.vllmGpuCount !== undefined ? args.vllmGpuCount : 1;

  if (args.appType === 'vllm' && (args.provider === 'k3d' || isMock)) {
    if (effectiveGpuCount > 0 && effectiveDevice !== 'cpu') {
      const gpuVendor = args.vllmGpuVendor || 'nvidia';
      try {
        await infra.checkGpuToolkit(gpuVendor);
        await infra.installGpuDevicePlugin(gpuVendor, kubeconfigPath);
      } catch (err: any) {
        console.warn(`[DeployAppActivity] GPU toolkit check or device plugin install failed (${err.message}). Falling back to CPU mode.`);
        effectiveDevice = 'cpu';
        effectiveGpuCount = 0;
      }
    }
  }

  // TabbyAPI (exllamav3) is CUDA-only with no CPU fallback, unlike vLLM above — a failed
  // toolkit check here can't be papered over by dropping to CPU, so we just warn and leave the
  // GPU count as configured; the pod will fail its own way if the toolkit truly isn't usable.
  const effectiveTabbyGpuCount = args.tabbyGpuCount !== undefined ? args.tabbyGpuCount : 1;
  if (args.appType === 'tabbyapi' && (args.provider === 'k3d' || isMock) && effectiveTabbyGpuCount > 0) {
    try {
      await infra.checkGpuToolkit('nvidia');
      await infra.installGpuDevicePlugin('nvidia', kubeconfigPath);
    } catch (err: any) {
      console.warn(`[DeployAppActivity] GPU toolkit check or device plugin install failed (${err.message}). TabbyAPI requires an NVIDIA GPU and cannot run in CPU mode.`);
    }
  }

  // ── 2. Build custom image or pull/import app image for k3d ──
  // `k3d image import` only makes sense against a real k3d cluster — it copies a
  // host-Docker-pulled image into that cluster's isolated, nested containerd. GPU-enabled
  // clusters attach to the native k3s management cluster instead (see ProvisionClusterActivity),
  // whose containerd is the host's only container runtime and pulls public images itself at
  // pod-start time — no import step exists or is needed there (attempting it fails with
  // "failed to get cluster <name>: No nodes found", since there's no such k3d cluster).
  if (args.modules && args.modules.length > 0) {
    customImageTag = await builder.buildCustomImage(
      args.odooRepo || `odoo:latest`,
      args.modules,
      args.appType,
      { logFile, resourceId: args.clusterId },
    );
    if (customImageTag) {
      if (args.clusterGpuEnabled) {
        console.warn(`[DeployAppActivity] Skipping k3d image import for GPU-attached cluster — custom-built image "${customImageTag}" exists only in the host's Docker daemon and is NOT visible to native k3s's containerd. The deployment will likely fail to pull it (ImagePullBackOff) unless it's pushed to a registry.`);
      } else {
        await infra.importImage(physicalName, customImageTag, { logFile });
      }
      const [repo, imageTag] = customImageTag.split(':');
      finalOdooRepo = repo || finalOdooRepo;
      finalOdooTag = imageTag || finalOdooTag;
    }
  } else if ((args.provider === 'k3d' || isMock) && !args.clusterGpuEnabled) {
    if (args.appType === 'vllm') {
      const vllmImageTag = (finalOdooTag && finalOdooTag !== 'latest') ? finalOdooTag : 'v0.7.2';
      const vllmImage = args.vllmGpuVendor === 'amd'
        ? `vllm/vllm-openai-rocm:${vllmImageTag}`
        : `vllm/vllm-openai:${vllmImageTag}`;
      await infra.pullAndImportImage(physicalName, vllmImage, { logFile });
    } else if (args.appType === 'tabbyapi') {
      const tabbyImageTag = args.tabbyImageTag === 'cu13' ? 'cu13' : 'latest';
      await infra.pullAndImportImage(physicalName, `ghcr.io/theroyallab/tabbyapi:${tabbyImageTag}`, { logFile });
    } else if (finalOdooRepo && finalOdooTag) {
      const appImage = `${finalOdooRepo}:${finalOdooTag}`;
      await infra.pullAndImportImage(physicalName, appImage, { logFile });
    }
    if (args.dbRepo && args.dbTag) {
      const dbImage = `${args.dbRepo}:${args.dbTag}`;
      await infra.pullAndImportImage(physicalName, dbImage, { logFile });
    }
  }

  const storageEnv = StorageAdapter.getStorageEnv(args.appType, args.strategy, {});
  const displayUrl = args.appType === 'odoo'
    ? 'http://localhost:8069'
    : args.appType === 'vllm'
    ? 'http://localhost:8000'
    : args.appType === 'tabbyapi'
    ? 'http://localhost:5000'
    : args.appType === 'openwebui'
    ? 'http://localhost:8080'
    : args.appType === 'gitapp'
    ? 'http://localhost:8080'
    : 'http://localhost:80';

  const deploymentId = args.deploymentId || uuidv4().slice(0, 8);

  // Real size from HuggingFace, not the repo-name regex guess tabbyapi.ts falls back to when
  // this is absent — sizes /dev/shm and the memory limit off what the model actually is rather
  // than a string match. Non-fatal on failure (rate limit, network blip, gated repo without a
  // token yet): the construct's own fallback estimate still runs, just less precisely.
  let tabbyModelSizeBytes: number | undefined;
  if (args.appType === 'tabbyapi' && args.tabbyModel) {
    try {
      const { getHfModelSize } = await import('../lib/huggingface.js');
      const size = await getHfModelSize(args.tabbyModel, args.tabbyRevision, args.tabbyHfToken);
      tabbyModelSizeBytes = size.totalBytes;
    } catch (err: any) {
      console.warn(`[DeployAppActivity] Could not fetch model size for ${args.tabbyModel}: ${err.message}`);
    }
  }

  const env = buildAppEnv({
    physicalName,
    strategy: args.strategy,
    sanitizedName,
    deploymentId,
    kubeconfigPath,
    provider: args.provider,
    isMock,
    appType: args.appType,
    webRepo: finalOdooRepo,
    webTag: finalOdooTag,
    dbRepo: args.dbRepo,
    dbTag: args.dbTag,
    vllmModel: args.vllmModel,
    vllmGpuCount: effectiveGpuCount,
    vllmGpuVendor: args.vllmGpuVendor,
    vllmCachePvc: args.vllmCachePvc,
    vllmDevice: effectiveDevice,
    vllmHfToken: args.vllmHfToken,
    vllmMaxModelLen: args.vllmMaxModelLen,
    vllmGpuMemUtil: args.vllmGpuMemUtil,
    vllmExtraArgs: args.vllmExtraArgs,
    vllmToolCallingEnabled: args.vllmToolCallingEnabled,
    vllmToolCallParser: args.vllmToolCallParser,
    vllmServedModelName: args.vllmServedModelName,
    vllmMaxNumSeqs: args.vllmMaxNumSeqs,
    vllmDtype: args.vllmDtype,
    vllmEnablePrefixCaching: args.vllmEnablePrefixCaching,
    tabbyModel: args.tabbyModel,
    tabbyRevision: args.tabbyRevision,
    tabbyGpuCount: effectiveTabbyGpuCount,
    tabbyModelSizeBytes,
    tabbyHfToken: args.tabbyHfToken,
    tabbyCachePvc: args.tabbyCachePvc,
    tabbyImageTag: args.tabbyImageTag,
    tabbyCacheMode: args.tabbyCacheMode,
    tabbyMaxSeqLen: args.tabbyMaxSeqLen,
    tabbyMaxBatchSize: args.tabbyMaxBatchSize,
    tabbyReasoning: args.tabbyReasoning,
    tabbyToolFormat: args.tabbyToolFormat,
    tabbyInlineModelLoading: args.tabbyInlineModelLoading,
    tabbyDisableAuth: args.tabbyDisableAuth,
    tabbyExtraEnv: args.tabbyExtraEnv,
    openaiApiBaseUrl: args.openaiApiBaseUrl,
    webuiEnableWebSearch: args.webuiEnableWebSearch,
    webuiWebSearchEngine: args.webuiWebSearchEngine,
    webuiWebSearchApiKey: args.webuiWebSearchApiKey,
    storageEnv,
  });

  // ── 4. Deploy the app stack via CDKTF ──
  await infra.deploy(
    `app-${physicalName}-${deploymentId}`,
    { logFile, env },
  );

  // gitapp images live on the self-hosted Gitea registry, which requires auth to pull from —
  // unlike every other app type here, which either uses a public image or one already imported
  // into the target cluster's containerd. Created *after* the CDKTF apply above (which is what
  // creates the namespace this secret needs to live in) rather than before — the pod will sit
  // in a brief ImagePullBackOff until this lands, then kubelet's own pull-retry picks the
  // secret up automatically; no coordination with CDKTF's own Namespace resource needed this way.
  if (args.appType === 'gitapp') {
    const gitea = new GiteaService(infra, process.env.JWT_SECRET || 'provisioning-platform-secret-12345', '/tmp/kubeconfig-provisioning-lunorica');
    const registryHost = await gitea.getRegistryHost();
    const deployToken = await gitea.createDeployToken();
    const secretYaml = await infra.runKubectl(
      ['create', 'secret', 'docker-registry', 'gitea-registry', '-n', sanitizedName,
        `--docker-server=${registryHost}`, `--docker-username=${gitea.adminUsername}`, `--docker-password=${deployToken.token}`,
        '--dry-run=client', '-o', 'yaml'],
      kubeconfigPath,
    );
    const tmpSecretPath = path.join(os.tmpdir(), `gitapp-registry-secret-${deploymentId}.yaml`);
    await fs.writeFile(tmpSecretPath, secretYaml as any);
    await infra.runKubectl(['apply', '-f', tmpSecretPath], kubeconfigPath);
    await fs.rm(tmpSecretPath, { force: true }).catch(() => {});
  }

  return {
    status: 'running',
    msg: `App ${args.appType}/${args.name} deployed`,
    displayUrl,
  };
}
