import type { InfrastructureService } from '../../infrastructure/index.js';
import { webhookUrlFor } from '../lib/project-shipping.js';

function nodeAddress(infra: Pick<InfrastructureService, 'runKubectl'>, kubeconfig: string): () => Promise<string> {
  let nodeIp: Promise<string> | undefined;
  const lookUp = () => infra.runKubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'], kubeconfig).then((out) => out.trim());
  return async () => {
    nodeIp ??= lookUp().catch((err: unknown) => { nodeIp = undefined; throw err; });
    const ip = await nodeIp;
    if (!ip) throw new Error('the cluster gave no node address for Gitea to send pushes to');
    return ip;
  };
}

export function webhookAddress(infra: Pick<InfrastructureService, 'runKubectl'>, kubeconfig: string, port: string | number): (projectId: string) => Promise<string> {
  const node = nodeAddress(infra, kubeconfig);
  return async (projectId) => webhookUrlFor(await node(), port, projectId);
}

export function backendAddress(infra: Pick<InfrastructureService, 'runKubectl'>, kubeconfig: string, port: string | number): () => Promise<string> {
  const node = nodeAddress(infra, kubeconfig);
  return async () => `http://${(await node()).split(/\s+/)[0] ?? ''}:${port}`;
}
