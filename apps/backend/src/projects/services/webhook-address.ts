import type { InfrastructureService } from '../../infrastructure/index.js';
import { webhookUrlFor } from '../lib/project-shipping.js';

export function webhookAddress(infra: Pick<InfrastructureService, 'runKubectl'>, kubeconfig: string, port: string | number): (projectId: string) => Promise<string> {
  let nodeIp: Promise<string> | undefined;
  const lookUp = () => infra.runKubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'], kubeconfig).then((out) => out.trim());
  return async (projectId) => {
    nodeIp ??= lookUp().catch((err: unknown) => { nodeIp = undefined; throw err; });
    const ip = await nodeIp;
    if (!ip) throw new Error('the cluster gave no node address for the build webhook');
    return webhookUrlFor(ip, port, projectId);
  };
}
