/**
 * DestroyClusterActivity
 *
 * Destroys the physical k3d cluster, runs any remaining CDKTF destroy,
 * and cleans up kubeconfig leftovers.
 */
import fs from 'fs/promises';
import path from 'path';

import { InfrastructureService } from '../services/InfrastructureService.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider } from '../lib/cluster-topology.js';
import { DestroyRemoteHostActivity } from './ProvisionRemoteHostActivity.js';
import { DestroyHetznerVmActivity } from './ProvisionHetznerVmActivity.js';

export interface DestroyClusterArgs {
  name: string;
  provider: string;
  logFile: string;
  gpuEnabled?: boolean;
  // provider === 'remote' AND 'hetzner' — see ProvisionClusterArgs for why privateKey arrives
  // decrypted. A Hetzner cluster populates these too (with the VM's IP and the generated key),
  // because from the bootstrap onward it IS a remote host.
  remoteHost?: string;
  remoteUsername?: string;
  remoteSshPort?: number;
  remoteSshPrivateKey?: string;
  // provider === 'hetzner' only — needed to destroy the VM itself and verify it's gone.
  hcloudToken?: string;
  hetznerServerId?: string;
}

export interface DestroyClusterResult {
  status: string;
  msg: string;
}

// Moved to lib/activity-timeouts.ts — see that file for why (workflow files must never import a
// VALUE from an activity file, only `import type`).
export { destroyClusterActivityMeta } from '../lib/activity-timeouts.js';

export async function DestroyClusterActivity(
  args: DestroyClusterArgs,
): Promise<DestroyClusterResult> {
  const infra = new InfrastructureService();
  const logFile = args.logFile;

  const isRemote = args.provider === 'remote';
  const isHetzner = args.provider === 'hetzner';
  // See ProvisionClusterActivity — both are in NEVER_MOCK_PROVIDERS (lib/cluster-topology.ts).
  const isMock = isMockCloudProvider(args.provider, hasCloudCredentials);
  const physicalName = isMock ? `mock-${args.provider}-${args.name}` : args.name;
  const kubeconfigPath = `/tmp/kubeconfig-${physicalName}`;

  // GPU-enabled clusters attach to the shared management cluster rather than owning a physical
  // cluster (see ProvisionClusterActivity) — there's nothing k3d-shaped to tear down. App-level
  // destroy already cleans up the namespaces/resources an app created; just drop the kubeconfig.
  if (args.gpuEnabled) {
    try {
      await fs.rm(kubeconfigPath, { force: true });
    } catch {}
    return { status: 'destroyed', msg: `Cluster ${args.name} detached from the management cluster` };
  }

  // 1. Destroy infrastructure stack — ObservabilityStack first (it depends on ClusterStack's
  // namespace/CRDs, see main.ts), then ClusterStack itself. The k3d cluster gets deleted outright
  // in step 2 below regardless, but destroying in dependency order keeps Terraform state clean
  // rather than leaving orphaned state pointing at a cluster that's about to stop existing.
  const clusterEnv = {
    STACK_TYPE: 'cluster',
    ENV: isMock ? 'local' : args.provider,
    CLUSTER_NAME: physicalName,
    KUBECONFIG_PATH: kubeconfigPath,
  };
  try {
    await infra.destroy(`${physicalName}-observability`, { logFile, env: clusterEnv });
  } catch {
    // Tolerated — clusters provisioned before this stack existed have no "-observability" CDKTF
    // state to destroy at all, and that's an expected, harmless case, not a real failure.
  }
  try {
    await infra.destroy(physicalName, { logFile, env: clusterEnv });
  } catch (err: any) {
    // Also tolerated, and this one is load-bearing: a cluster whose provision failed before the
    // stack was ever created cannot be destroyed by CDKTF either, so throwing here made the record
    // permanently undeletable. A cluster named "VPS -test" hit this exactly — cdktf refuses to
    // synthesize a stack id containing whitespace, so provision and destroy failed identically and
    // the record could never be removed through the UI.
    //
    // Safe to continue because this stack only ever holds IN-CLUSTER resources (Traefik,
    // kube-prometheus-stack). Everything that actually costs money or outlives this activity is
    // torn down below and verified there: k3d clusters are deleted outright, remote hosts get a
    // k3s uninstall, and the Hetzner VM is deleted through DestroyHetznerVmActivity, which
    // confirms against Hetzner's own API rather than trusting Terraform's word for it.
    console.warn(`[DestroyClusterActivity] ClusterStack destroy failed for "${physicalName}" (continuing to substrate teardown): ${err.message}`);
  }

  // 2. Delete the physical k3d cluster if applicable
  if (args.provider === 'k3d' || isMock) {
    await infra.deleteLocalCluster(physicalName, { logFile });
    await infra.disconnectNginxFromNetwork(physicalName);
    try {
      await fs.rm(kubeconfigPath, { force: true });
    } catch {}
  } else if (isRemote) {
    // Best-effort — a host that's already gone (e.g. a since-destroyed VPS in Phase 3, or a GPU
    // workstation that's simply offline right now) can't be SSH'd into to uninstall k3s, and
    // that's fine: nothing is left behind on THIS side but the kubeconfig file removed below.
    // TODO(distributed-system plan, Phase 2 follow-up): also revoke the Headscale mesh device
    // (ClusterMetadata.meshNodeId) — not wired up here since Temporal activities don't have
    // access to the backend's HeadscaleService/masterKey; the user can revoke it manually via
    // DELETE /api/mesh/devices/:nodeId in the meantime.
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
    // Deliberately no k3s uninstall here, unlike the 'remote' branch above: the entire machine is
    // about to be deleted, so uninstalling software on it first is pure latency (and would fail
    // anyway if the VM is already unreachable).
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
    // Surfaced rather than swallowed: "Terraform said it destroyed the VM" and "Hetzner confirms
    // the VM is gone" are different claims, and only the second one stops the billing.
    return { status: 'destroyed', msg: `Cluster ${args.name} destroyed — ${result.msg}` };
  }

  return { status: 'destroyed', msg: `Cluster ${args.name} destroyed` };
}
