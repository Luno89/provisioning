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

export interface DeployAppArgs {
  name: string;
  clusterId: string;
  clusterName: string;
  provider: string;
  strategy: string;
  appType: string;
  modules?: string[];
  odooRepo: string;
  odooTag: string;
  dbRepo: string;
  dbTag: string;
  logFile: string;
  deploymentId?: string;
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

  let customImageTag: string | undefined;

  // ── 1. Build custom image if modules are selected ──
  if (args.modules && args.modules.length > 0) {
    customImageTag = await builder.buildCustomImage(
      args.odooRepo || `odoo:latest`,
      args.modules,
      args.appType,
      { logFile, resourceId: args.clusterId },
    );
    if (customImageTag) {
      await infra.importImage(args.clusterName, customImageTag, { logFile });
      const [repo, imageTag] = customImageTag.split(':');
      finalOdooRepo = repo || finalOdooRepo;
      finalOdooTag = imageTag || finalOdooTag;
    }
  }

  // ── 2. Get kubeconfig for k3d clusters ──
  const kubeconfigPath = args.provider === 'k3d'
    ? `/tmp/kubeconfig-${args.clusterName}`
    : path.join(LIVE_ROOT, '.kube/config');

  const storageEnv = StorageAdapter.getStorageEnv(args.appType, args.strategy, {});
  const displayUrl = args.appType === 'odoo'
    ? 'http://localhost:8069'
    : 'http://localhost:80';

  const deploymentId = args.deploymentId || uuidv4().slice(0, 8);

  const env: Record<string, string> = {
    STACK_TYPE: 'app',
    CLUSTER_NAME: args.clusterName,
    DEPLOYMENT_STRATEGY: args.strategy,
    DEPLOYMENT_NAME: sanitizedName,
    DEPLOYMENT_ID: deploymentId,
    KUBECONFIG: kubeconfigPath,
    KUBECONFIG_CONTEXT: args.provider === 'k3d' ? `k3d-${args.clusterName}` : '',
    APP_TYPE: args.appType,
    WEB_IMAGE_REPO: finalOdooRepo || '',
    WEB_IMAGE_TAG: finalOdooTag || '',
    DB_IMAGE_REPO: args.dbRepo || '',
    DB_IMAGE_TAG: args.dbTag || '',
    VPN_ENABLED: 'false',
    VPN_PROTOCOL: 'wireguard',
    VPN_CONFIG: '',
    VPN_DEDICATED_IP: '',
    ODOO_IMAGE_REPO: finalOdooRepo || '',
    ODOO_IMAGE_TAG: finalOdooTag || '',
    POSTGRES_IMAGE_REPO: args.dbRepo || '',
    POSTGRES_IMAGE_TAG: args.dbTag || '',
    ...storageEnv,
  };

  await infra.deploy(
    `app-${args.clusterName}-${deploymentId}`,
    { logFile, env },
  );

  return {
    status: 'running',
    msg: `App ${args.appType}/${args.name} deployed`,
    displayUrl,
  };
}
