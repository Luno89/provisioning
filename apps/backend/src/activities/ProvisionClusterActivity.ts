/**
 * ProvisionClusterActivity
 *
 * Performs the physical k3d cluster provisioning: creates the cluster, patches
 * CoreDNS for hostnetwork DNS resolution, patches the local-path StorageClass
 * for volume expansion, and deploys the infrastructure stack (monitoring, agent).
 */
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';

import { InfrastructureService } from '../services/InfrastructureService.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';

export interface ProvisionClusterArgs {
  name: string;
  provider: string;
  logFile: string;
}

export interface ProvisionClusterResult {
  status: string;
  kubeconfigPath: string;
  msg: string;
  logFile: string;
}

export const provisionClusterActivityMeta = {
  name: 'ProvisionClusterActivity',
  startToCloseTimeout: '80 minutes',
};

export async function ProvisionClusterActivity(
  args: ProvisionClusterArgs,
): Promise<ProvisionClusterResult> {
  const infra = new InfrastructureService();
  const logFile = args.logFile;

  const isMock = args.provider !== 'k3d' && !hasCloudCredentials(args.provider);
  const physicalName = isMock ? `mock-${args.provider}-${args.name}` : args.name;
  const kubeconfigPath = `/tmp/kubeconfig-${physicalName}`;

  // GPU passthrough is exclusively provided by the always-on system cluster (native k3s on
  // Linux; k3d's nested containerd can't do real device passthrough at all — see AGENTS.md).
  // User-created clusters here are always plain k3d, no GPU attach step.
  if (args.provider === 'k3d' || isMock) {
    try {
      await infra.runKubectl(['config', 'unset', 'clusters.k3d-' + physicalName]);
    } catch {}

    await infra.createLocalCluster(physicalName, { logFile });

    const kubeconfigContent = await infra.getKubeconfig(physicalName);
    await fs.writeFile(kubeconfigPath, kubeconfigContent, 'utf-8');

    // --- Wait for cluster API server and nodes to become responsive and ready ---
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

      // Check docker logs for file descriptor limit exhaustion inside the Colima/Docker VM
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

    // --- Patch local-path StorageClass to allow volume expansion ---
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

    // --- Patch CoreDNS ConfigMap to avoid hostnetwork DNS loop ---
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

    // Give it an additional stabilization delay
    await new Promise((r) => setTimeout(r, 5000));
  }

  // 5. Clean up orphaned resources from previous failed deploy attempts
  try {
    await infra.runHelm(['uninstall', 'traefik', '-n', 'traefik', '--wait', '--timeout', '5m'], kubeconfigPath);
  } catch {
    // No existing traefik release — expected on first run
  }
  try {
    await infra.runHelm(['uninstall', 'traefik', '-n', 'kube-system', '--wait', '--timeout', '5m'], kubeconfigPath);
  } catch {
    // No existing traefik release in kube-system
  }
  try {
    await infra.runHelm(['uninstall', 'kube-prometheus-stack', '-n', 'monitoring', '--wait', '--timeout', '5m'], kubeconfigPath);
  } catch {
    // No existing prometheus release — expected on first run
  }
  try {
    await infra.runKubectl(['delete', 'ingressclass', 'traefik', '--ignore-not-found'], kubeconfigPath);
  } catch {
    // IngressClass already gone
  }
  // Force-remove stale helm annotations from IngressClass if it still exists
  try {
    await infra.runKubectl(['patch', 'ingressclass', 'traefik', '--type=json', '-p=[{"op":"remove","path":"/metadata/annotations"}]', '--ignore-not-found'], kubeconfigPath);
  } catch {}
  // Wait for IngressClass to be fully deleted
  await new Promise((r) => setTimeout(r, 2000));
  // Verify IngressClass is gone before proceeding
  try {
    await infra.runKubectl(['get', 'ingressclass', 'traefik'], kubeconfigPath);
    // Still exists, force delete with annotations removed
    await infra.runKubectl(['patch', 'ingressclass', 'traefik', '--type=json', '-p=[{"op":"remove","path":"/metadata/annotations"}]', '--ignore-not-found'], kubeconfigPath);
    await infra.runKubectl(['delete', 'ingressclass', 'traefik', '--ignore-not-found'], kubeconfigPath);
    await new Promise((r) => setTimeout(r, 2000));
  } catch {
    // IngressClass is gone
  }
  try {
    await infra.destroy(physicalName, {
      logFile,
      env: {
        STACK_TYPE: 'cluster',
        ENV: isMock ? 'local' : args.provider,
        CLUSTER_NAME: physicalName,
        KUBECONFIG_PATH: kubeconfigPath,
      },
    });
  } catch {
    // No prior CDKTF state — expected on first run
  }

  // 6. Deploy the infrastructure stack (Monitoring, etc.)
  const env: Record<string, string> = {
    STACK_TYPE: 'cluster',
    ENV: isMock ? 'local' : args.provider,
    CLUSTER_NAME: physicalName,
    KUBECONFIG_PATH: kubeconfigPath,
  };
  const deployTimeout = (args.provider === 'k3d' || isMock) ? 10 * 60 * 1000 : 25 * 60 * 1000;
  await infra.deploy(physicalName, { logFile, env, timeout: deployTimeout });

  return { status: 'healthy', kubeconfigPath, msg: `Cluster ${args.name} provisioned`, logFile };
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
