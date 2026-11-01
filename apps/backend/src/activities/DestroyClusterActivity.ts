import fs from 'fs/promises';

import { InfrastructureService, hasCloudCredentials, isMockCloudProvider } from '../infrastructure/index.js';
import { DestroyRemoteHostActivity } from './ProvisionRemoteHostActivity.js';
import { DestroyHetznerVmActivity } from './ProvisionHetznerVmActivity.js';
import { DestroyDigitalOceanVmActivity } from './ProvisionDigitalOceanVmActivity.js';
import { messageOf } from './failure-reasons.js';

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
  const forgetKubeconfig = () => fs.rm(kubeconfigPath, { force: true }).catch((err: unknown) => {
    console.warn(`[DestroyClusterActivity] the kubeconfig of the destroyed cluster "${physicalName}" could not be removed from ${kubeconfigPath}: ${messageOf(err)}`);
  });

  if (args.gpuEnabled) {
    await forgetKubeconfig();
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
  } catch (err) {
    console.warn(`[DestroyClusterActivity] ObservabilityStack destroy failed for "${physicalName}" (continuing to the cluster stack): ${messageOf(err)}`);
  }
  try {
    await infra.destroy(physicalName, { logFile, env: clusterEnv });
  } catch (err) {
    console.warn(`[DestroyClusterActivity] ClusterStack destroy failed for "${physicalName}" (continuing to substrate teardown): ${messageOf(err)}`);
  }

  if (args.provider === 'k3d' || isMock) {
    await infra.deleteLocalCluster(physicalName, { logFile });
    await infra.disconnectNginxFromNetwork(physicalName);
    await forgetKubeconfig();
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
      } catch (err) {
        console.warn(`[DestroyClusterActivity] Remote k3s uninstall failed (continuing): ${messageOf(err)}`);
      }
    }
    await forgetKubeconfig();
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
    await forgetKubeconfig();
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
    await forgetKubeconfig();
    return { status: 'destroyed', msg: `Cluster ${args.name} destroyed — ${result.msg}` };
  }

  return { status: 'destroyed', msg: `Cluster ${args.name} destroyed` };
}
