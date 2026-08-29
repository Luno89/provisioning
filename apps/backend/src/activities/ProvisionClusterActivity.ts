import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';

import { InfrastructureService } from '../services/InfrastructureService.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider } from '../lib/cluster-topology.js';
import { ProvisionRemoteHostActivity } from './ProvisionRemoteHostActivity.js';
import { ProvisionHetznerVmActivity } from './ProvisionHetznerVmActivity.js';
import { ProvisionDigitalOceanVmActivity } from './ProvisionDigitalOceanVmActivity.js';
import { JoinMeshActivity } from './JoinMeshActivity.js';
import { capacityFromNodes, type ClusterCapacity } from '../lib/cluster-capacity.js';

export interface ProvisionClusterArgs {
  name: string;
  provider: string;
  logFile: string;
  remoteHost?: string;
  remoteUsername?: string;
  remoteSshPort?: number;
  remoteSshPrivateKey?: string;
  remoteK3sApiPort?: number;
  hcloudToken?: string;
  hetznerServerType?: string;
  hetznerLocation?: string;
  hetznerImage?: string;
  hetznerSshPrivateKey?: string;
  hetznerSshPublicKey?: string;
  doToken?: string;
  doSize?: string;
  doRegion?: string;
  doImage?: string;
  doSshPrivateKey?: string;
  doSshPublicKey?: string;
  meshLoginServer?: string;
  meshPreAuthKey?: string;
}

export interface ProvisionClusterResult {
  status: string;
  kubeconfigPath: string;
  msg: string;
  logFile: string;
  hetznerServerId?: string;
  doServerId?: string;
  createdHost?: string;
  createdUsername?: string;
  createdPrivateKey?: string;
  meshIp?: string;
  capacity?: ClusterCapacity;
}

export { provisionClusterActivityMeta } from '../lib/activity-timeouts.js';

export async function ProvisionClusterActivity(
  args: ProvisionClusterArgs,
): Promise<ProvisionClusterResult> {
  const infra = new InfrastructureService();
  const logFile = args.logFile;

  const isRemote = args.provider === 'remote';
  const isHetzner = args.provider === 'hetzner';
  const isDigitalOcean = args.provider === 'do';
  const isMock = isMockCloudProvider(args.provider, hasCloudCredentials);
  const physicalName = isMock ? `mock-${args.provider}-${args.name}` : args.name;
  const kubeconfigPath = `/tmp/kubeconfig-${physicalName}`;
  let vm: { host: string; serverId: string; privateKey: string; username: string } | undefined;
  let meshIp: string | undefined;

  if (args.provider === 'k3d' || isMock) {
    try {
      await infra.runKubectl(['config', 'unset', 'clusters.k3d-' + physicalName]);
    } catch {}

    await infra.createLocalCluster(physicalName, { logFile });

    const kubeconfigContent = await infra.getKubeconfig(physicalName);
    await fs.writeFile(kubeconfigPath, kubeconfigContent, 'utf-8');

    let ready = false;
    for (let i = 0; i < 45; i++) {
      try {
        const nodesJson = await infra.runKubectl(['get', 'nodes', '-o', 'json'], kubeconfigPath);
        const nodesObj = JSON.parse(nodesJson);
        const nodes = nodesObj.items || [];
        const hasReadyNode = nodes.some((node: any) =>
          node.status?.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True')
        );
        if (hasReadyNode) {
          ready = true;
          break;
        }
      } catch {}

      if (i > 0 && i % 5 === 0) {
        try {
          const containerName = `k3d-${physicalName}-server-0`;
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);
          const { stdout, stderr } = await execAsync(`docker logs --tail 200 ${containerName}`);
          const logs = stdout + '\n' + stderr;
          if (logs.includes('too many open files') || logs.includes('fsnotify')) {
            throw new Error(`Docker/Colima VM resource limit exhausted: 'too many open files' in K3s file watcher. Please run 'colima restart' in your terminal to reset the VM limits.`);
          }
        } catch (logErr: any) {
          if (logErr.message.includes('VM resource limit')) {
            throw logErr;
          }
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!ready) {
      throw new Error(`Cluster ${physicalName} did not get a Ready control plane node in time.`);
    }

    let scPatched = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await infra.runKubectl([
          'patch', 'storageclass', 'local-path',
          '-p', JSON.stringify({ allowVolumeExpansion: true }),
        ], kubeconfigPath);
        scPatched = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!scPatched) {
      console.warn(`[ProvisionClusterActivity] local-path StorageClass could not be patched`);
    }

    const dnsList = await getRealNameservers();
    let corednsPatched = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const cmJson = await infra.runKubectl(
          ['get', 'configmap', 'coredns', '-n', 'kube-system', '-o', 'json'],
          kubeconfigPath,
        );
        const cm = JSON.parse(cmJson);
        if (cm?.data?.Corefile) {
          const updated = cm.data.Corefile.replace(
            /forward\s+\.\s+\/etc\/resolv\.conf/g,
            `forward . ${dnsList.join(' ')}`,
          );
          if (updated !== cm.data.Corefile) {
            cm.data.Corefile = updated;
            const containerName = `k3d-${physicalName}-server-0`;
            const cmJsonString = JSON.stringify(cm).replace(/'/g, "'\\''");
            const exec = (await import('child_process')).exec;
            await (await import('util')).promisify(exec)(
              `echo '${cmJsonString}' | docker exec -i ${containerName} kubectl replace -f -`,
            );
            await infra.runKubectl(
              ['rollout', 'restart', 'deployment/coredns', '-n', 'kube-system'],
              kubeconfigPath,
            );
            corednsPatched = true;
            break;
          }
        }
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!corednsPatched && !dnsList) {
      console.warn(`[ProvisionClusterActivity] CoreDNS ConfigMap was not available or patched.`);
    }

    await new Promise((r) => setTimeout(r, 5000));
  } else if (isRemote) {
    if (!args.remoteHost || !args.remoteUsername || !args.remoteSshPrivateKey) {
      throw new Error('provider "remote" requires remoteHost, remoteUsername, and remoteSshPrivateKey');
    }
    await ProvisionRemoteHostActivity({
      physicalName,
      host: args.remoteHost,
      username: args.remoteUsername,
      privateKey: args.remoteSshPrivateKey,
      ...(args.remoteSshPort !== undefined ? { port: args.remoteSshPort } : {}),
      ...(args.remoteK3sApiPort !== undefined ? { k3sApiPort: args.remoteK3sApiPort } : {}),
    });
  } else if (isHetzner) {
    if (!args.hcloudToken) {
      throw new Error('provider "hetzner" requires a Hetzner Cloud API token — add one under Cloud Accounts');
    }
    vm = await ProvisionHetznerVmActivity({
      name: physicalName,
      hcloudToken: args.hcloudToken,
      logFile,
      ...(args.hetznerServerType ? { serverType: args.hetznerServerType } : {}),
      ...(args.hetznerLocation ? { location: args.hetznerLocation } : {}),
      ...(args.hetznerImage ? { image: args.hetznerImage } : {}),
      ...(args.hetznerSshPrivateKey ? { sshPrivateKey: args.hetznerSshPrivateKey } : {}),
      ...(args.hetznerSshPublicKey ? { sshPublicKey: args.hetznerSshPublicKey } : {}),
    });
    let reachableHost = vm.host;
    if (args.meshLoginServer && args.meshPreAuthKey) {
      const mesh = await JoinMeshActivity({
        physicalName,
        host: vm.host,
        username: vm.username,
        privateKey: vm.privateKey,
        loginServer: args.meshLoginServer,
        preAuthKey: args.meshPreAuthKey,
      });
      reachableHost = mesh.meshIp;
      meshIp = mesh.meshIp;
    }

    await ProvisionRemoteHostActivity({
      physicalName,
      host: reachableHost,
      username: vm.username,
      privateKey: vm.privateKey,
    });
  } else if (isDigitalOcean) {
    if (!args.doToken) {
      throw new Error('provider "do" requires a DigitalOcean API token — add one under Cloud Accounts');
    }
    vm = await ProvisionDigitalOceanVmActivity({
      name: physicalName,
      doToken: args.doToken,
      logFile,
      ...(args.doSize ? { size: args.doSize } : {}),
      ...(args.doRegion ? { region: args.doRegion } : {}),
      ...(args.doImage ? { image: args.doImage } : {}),
      ...(args.doSshPrivateKey ? { sshPrivateKey: args.doSshPrivateKey } : {}),
      ...(args.doSshPublicKey ? { sshPublicKey: args.doSshPublicKey } : {}),
    });

    let reachableHost = vm.host;
    if (args.meshLoginServer && args.meshPreAuthKey) {
      const mesh = await JoinMeshActivity({
        physicalName,
        host: vm.host,
        username: vm.username,
        privateKey: vm.privateKey,
        loginServer: args.meshLoginServer,
        preAuthKey: args.meshPreAuthKey,
      });
      reachableHost = mesh.meshIp;
      meshIp = mesh.meshIp;
    }

    await ProvisionRemoteHostActivity({
      physicalName,
      host: reachableHost,
      username: vm.username,
      privateKey: vm.privateKey,
    });
  }

  try {
    await infra.runHelm(['uninstall', 'traefik', '-n', 'traefik', '--wait', '--timeout', '5m'], kubeconfigPath);
  } catch {
  }
  try {
    await infra.runHelm(['uninstall', 'traefik', '-n', 'kube-system', '--wait', '--timeout', '5m'], kubeconfigPath);
  } catch {
  }
  try {
    await infra.runHelm(['uninstall', 'kube-prometheus-stack', '-n', 'monitoring', '--wait', '--timeout', '5m'], kubeconfigPath);
  } catch {
  }
  try {
    await infra.runKubectl(['delete', 'ingressclass', 'traefik', '--ignore-not-found'], kubeconfigPath);
  } catch {
  }
  try {
    await infra.runKubectl(['patch', 'ingressclass', 'traefik', '--type=json', '-p=[{"op":"remove","path":"/metadata/annotations"}]', '--ignore-not-found'], kubeconfigPath);
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));
  try {
    await infra.runKubectl(['get', 'ingressclass', 'traefik'], kubeconfigPath);
    await infra.runKubectl(['patch', 'ingressclass', 'traefik', '--type=json', '-p=[{"op":"remove","path":"/metadata/annotations"}]', '--ignore-not-found'], kubeconfigPath);
    await infra.runKubectl(['delete', 'ingressclass', 'traefik', '--ignore-not-found'], kubeconfigPath);
    await new Promise((r) => setTimeout(r, 2000));
  } catch {
  }
  const clusterEnv: Record<string, string> = {
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
  } catch {
  }

  const deployTimeout = (args.provider === 'k3d' || isMock) ? 10 * 60 * 1000 : 25 * 60 * 1000;
  await infra.deploy(physicalName, { logFile, env: clusterEnv, timeout: deployTimeout });
  await infra.deploy(`${physicalName}-observability`, { logFile, env: clusterEnv, timeout: deployTimeout });

  let capacity: ClusterCapacity | undefined;
  try {
    const nodesJson = await infra.runKubectl(['get', 'nodes', '-o', 'json'], kubeconfigPath);
    capacity = capacityFromNodes(JSON.parse(nodesJson));
  } catch (err: any) {
    await fs.appendFile(logFile, `[capacity] could not read node capacity: ${err.message}\n`).catch(() => {});
  }

  return {
    status: 'healthy',
    kubeconfigPath,
    msg: `Cluster ${args.name} provisioned`,
    logFile,
    ...(meshIp ? { meshIp } : {}),
    ...(capacity ? { capacity } : {}),
    ...(vm
      ? {
          ...(isDigitalOcean ? { doServerId: vm.serverId } : { hetznerServerId: vm.serverId }),
          createdHost: vm.host,
          createdUsername: vm.username,
          createdPrivateKey: vm.privateKey,
        }
      : {}),
  };
}

const PRESETS = ['/run/systemd/resolve/resolv.conf', '/var/run/systemd/resolve/resolv.conf', '/etc/resolv.conf'] as const;

async function getRealNameservers(): Promise<string[]> {
  for (const p of PRESETS) {
    try {
      const lines = await Promise.resolve()
        .then(() => fs.readFile(p, 'utf-8'))
        .then((c) => c.split('\n'))
        .catch(() => []);
      const ips = lines
        .map((l) => l.trim())
        .flatMap((l) => {
          if (l.startsWith('nameserver ')) return l.substring(11).trim().split(/\s+/);
          return [];
        })
        .filter((ip) => ip && !ip.startsWith('127.') && ip !== '::1');
      if (ips.length > 0) return ips;
    } catch {
      continue;
    }
  }
  return ['8.8.8.8', '1.1.1.1'];
}
