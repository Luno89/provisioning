import fs from 'fs/promises';
import path from 'path';

import { InfrastructureService } from '../services/InfrastructureService.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider } from '../lib/cluster-topology.js';
import { DestroyRemoteHostActivity } from './ProvisionRemoteHostActivity.js';
import { DestroyHetznerVmActivity } from './ProvisionHetznerVmActivity.js';
import { DestroyDigitalOceanVmActivity } from './ProvisionDigitalOceanVmActivity.js';

export interface DestroyClusterArgs {
  name: string;
  provider: string;
  logFile: string;
  gpuEnabled?: boolean;
  remoteHost?: string;
  remoteUsername?: string;
  remoteSshPort?: number;
  remoteSshPrivateKey?: string;
  hcloudToken?: string;
  hetznerServerId?: string;
  doToken?: string;
  doServerId?: string;
}

export interface DestroyClusterResult {
  status: string;
  msg: string;
}

export { destroyClusterActivityMeta } from '../lib/activity-timeouts.js';

export async function DestroyClusterActivity(
  args: DestroyClusterArgs,
): Promise<DestroyClusterResult> {
  const infra = new InfrastructureService();
  const logFile = args.logFile;

  const isRemote = args.provider === 'remote';
  const isHetzner = args.provider === 'hetzner';
  const isDigitalOcean = args.provider === 'do';
  const isMock = isMockCloudProvider(args.provider, hasCloudCredentials);
  const physicalName = isMock ? `mock-${args.provider}-${args.name}` : args.name;
  const kubeconfigPath = `/tmp/kubeconfig-${physicalName}`;

  if (args.gpuEnabled) {
    try {
      await fs.rm(kubeconfigPath, { force: true });
    } catch {}
    return { status: 'destroyed', msg: `Cluster ${args.name} detached from the management cluster` };
  }

  const clusterEnv = {
    STACK_TYPE: 'cluster',
    ENV: isMock ? 'local' : args.provider,
    CLUSTER_NAME: physicalName,
    KUBECONFIG_PATH: kubeconfigPath,
  };
  try {
    await infra.destroy(`${physicalName}-observability`, { logFile, env: clusterEnv });
  } catch {
  }
  try {
    await infra.destroy(physicalName, { logFile, env: clusterEnv });
  } catch (err: any) {
    console.warn(`[DestroyClusterActivity] ClusterStack destroy failed for "${physicalName}" (continuing to substrate teardown): ${err.message}`);
  }

  if (args.provider === 'k3d' || isMock) {
    await infra.deleteLocalCluster(physicalName, { logFile });
    await infra.disconnectNginxFromNetwork(physicalName);
    try {
      await fs.rm(kubeconfigPath, { force: true });
    } catch {}
  } else if (isRemote) {
    if (args.remoteHost && args.remoteUsername && args.remoteSshPrivateKey) {
      try {
        await DestroyRemoteHostActivity({
          physicalName,
          host: args.remoteHost,
          username: args.remoteUsername,
          privateKey: args.remoteSshPrivateKey,
          ...(args.remoteSshPort !== undefined ? { port: args.remoteSshPort } : {}),
        });
      } catch (err: any) {
        console.warn(`[DestroyClusterActivity] Remote k3s uninstall failed (continuing): ${err.message}`);
      }
    }
    try {
      await fs.rm(kubeconfigPath, { force: true });
    } catch {}
  } else if (isHetzner) {
    if (!args.hcloudToken) {
      throw new Error('provider "hetzner" requires a Hetzner Cloud API token to destroy the VM');
    }
    const result = await DestroyHetznerVmActivity({
      name: physicalName,
      hcloudToken: args.hcloudToken,
      logFile,
      ...(args.hetznerServerId ? { serverId: args.hetznerServerId } : {}),
    });
    try {
      await fs.rm(kubeconfigPath, { force: true });
    } catch {}
    return { status: 'destroyed', msg: `Cluster ${args.name} destroyed — ${result.msg}` };
  } else if (isDigitalOcean) {
    if (!args.doToken) {
      throw new Error('provider "do" requires a DigitalOcean API token to destroy the droplet');
    }
    const result = await DestroyDigitalOceanVmActivity({
      name: physicalName,
      doToken: args.doToken,
      logFile,
      ...(args.doServerId ? { serverId: args.doServerId } : {}),
    });
    try {
      await fs.rm(kubeconfigPath, { force: true });
    } catch {}
    return { status: 'destroyed', msg: `Cluster ${args.name} destroyed — ${result.msg}` };
  }

  return { status: 'destroyed', msg: `Cluster ${args.name} destroyed` };
}
