import {
  DEFAULT_WORKSPACE_LANGUAGE, EGRESS_PROXY_EGRESS, EGRESS_PROXY_HOST, WORKSPACE_MOUNT,
  type EgressRule,
} from './workspace-image-seeds.js';

export const CLUSTER_DNS_EGRESS = {
  to: [{
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
    podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
  }],
  ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
};

export type { WorkspaceLanguage, EgressRule } from './workspace-image-seeds.js';
export { DEFAULT_WORKSPACE_LANGUAGE, WORKSPACE_MOUNT, EGRESS_PROXY_HOST, EGRESS_PROXY_EGRESS };

export function egressForBindings(
  bindings: readonly { port: number; source: { namespace: string } }[],
): EgressRule[] {
  const byNamespace = new Map<string, Set<number>>();
  for (const b of bindings) {
    const ports = byNamespace.get(b.source.namespace) ?? new Set<number>();
    ports.add(b.port);
    byNamespace.set(b.source.namespace, ports);
  }
  return [...byNamespace.entries()].map(([namespace, ports]) => ({ namespace, ports: [...ports] }));
}
