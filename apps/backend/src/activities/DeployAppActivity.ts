/**
 * DeployAppActivity
 *
 * Runs the deployment pipeline: builds a custom image if modules are selected,
 * imports it into the cluster (for k3d), then CDKTF-deploys the app stack.
 */
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { InfrastructureService } from '../services/InfrastructureService.js';
import { BuilderService } from '../services/BuilderService.js';
import { StorageAdapter } from '../services/StorageAdapter.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { buildAppEnv } from '../lib/app-env.js';

export interface DeployAppArgs {
  name: string;
  clusterId: string;
  clusterName: string;
  provider: string;
  strategy: string;
  appType: string;
  clusterGpuEnabled?: boolean;
  modules?: string[];
  odooRepo: string;
  odooTag: string;
  dbRepo: string;
  dbTag: string;
  logFile: string;
  deploymentId?: string;
  vllmModel?: string;
  vllmGpuCount?: number;
  vllmGpuVendor?: 'nvidia' | 'amd';
  vllmCachePvc?: string;
  vllmHfToken?: string;
  vllmMaxModelLen?: number;
  vllmGpuMemUtil?: number;
  vllmExtraArgs?: string;
  vllmToolCallingEnabled?: boolean;
  vllmToolCallParser?: string;
  vllmServedModelName?: string;
  vllmMaxNumSeqs?: number;
  vllmDtype?: string;
  vllmEnablePrefixCaching?: boolean;
  openaiApiBaseUrl?: string;
}

export interface DeployAppResult {
  status: string;
  msg: string;
  displayUrl: string;
}

export const deployAppActivityMeta = {
  name: 'DeployAppActivity',
  startToCloseTimeout: '80 minutes',
};

const SANITIZE = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const LIVE_ROOT = process.cwd();

export async function DeployAppActivity(
  args: DeployAppArgs,
): Promise<DeployAppResult> {
  const infra = new InfrastructureService();
  const builder = new BuilderService({}, infra);
  const logFile = args.logFile;
  const sanitizedName = SANITIZE(args.name);

  const finalOdooRepo = args.odooRepo || (args.appType === 'odoo' ? 'library/odoo' : '');
  const finalOdooTag = args.odooTag || (args.appType === 'odoo' ? '18.0' : '');

  const isMock = args.provider !== 'k3d' && !hasCloudCredentials(args.provider);
  const physicalName = isMock ? `mock-${args.provider}-${args.clusterName}` : args.clusterName;

  let customImageTag: string | undefined;

  const kubeconfigPath = (args.provider === 'k3d' || isMock)
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
    : args.appType === 'openwebui'
    ? 'http://localhost:8080'
    : 'http://localhost:80';

  const deploymentId = args.deploymentId || uuidv4().slice(0, 8);

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
    openaiApiBaseUrl: args.openaiApiBaseUrl,
    storageEnv,
  });

  // ── 4. Deploy the app stack via CDKTF ──
  await infra.deploy(
    `app-${physicalName}-${deploymentId}`,
    { logFile, env },
  );

  return {
    status: 'running',
    msg: `App ${args.appType}/${args.name} deployed`,
    displayUrl,
  };
}
