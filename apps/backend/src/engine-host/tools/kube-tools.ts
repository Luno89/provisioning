import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { ClusterMetadata, DeploymentMetadata } from '../../lib/types.js';
import {
  eventsCommand, findDeployment, logsCommand, namespaceOf, planRead, trimOutput,
  type OwnedDeployment,
} from '../../lib/kube-diagnostics.js';

export interface KubeAccess {
  clusters(ownerId: string): Promise<ClusterMetadata[]>;
  deployments(): Promise<DeploymentMetadata[]>;
  kubectl(cluster: ClusterMetadata, argv: string[]): Promise<string>;
}

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });
const answer = (digest: string, content: string): ToolOutcome => ({ ok: true, digest, content });

export function createKubeTools(options: { access: KubeAccess }): Record<string, ToolHandler> {
  const { access } = options;

  const world = async (ownerId: string) => {
    const clusters = await access.clusters(ownerId);
    const deployments: (OwnedDeployment & { record: DeploymentMetadata })[] = (await access.deployments())
      .filter((deployment) => deployment.ownerId === ownerId)
      .map((deployment) => ({
        name: deployment.name,
        namespace: namespaceOf(deployment.name),
        clusterId: deployment.clusterId,
        ownerId: deployment.ownerId,
        record: deployment,
      }));
    return { clusters, deployments };
  };

  const clusterNamed = (clusters: readonly ClusterMetadata[], name: string) =>
    clusters.find((cluster) => cluster.name.toLowerCase() === name.toLowerCase() || cluster.id === name);

  const read = async (cluster: ClusterMetadata, argv: string[]): Promise<string> =>
    trimOutput(await access.kubectl(cluster, argv).catch((err: Error) => `could not read: ${String(err.message).slice(0, 300)}`));

  const deploymentAndCluster = async (ownerId: string, wanted: string | undefined) => {
    if (!wanted) return { problem: 'name one of your deployments' } as const;
    const { clusters, deployments } = await world(ownerId);
    const deployment = findDeployment(wanted, deployments, ownerId);
    if (!deployment) {
      const names = deployments.map((entry) => entry.name).join(', ') || 'none';
      return { problem: `you have no deployment called "${wanted}" — yours are: ${names}` } as const;
    }
    const cluster = clusters.find((entry) => entry.id === deployment.clusterId || entry.name === deployment.clusterId);
    if (!cluster) return { problem: `the cluster ${deployment.name} runs on (${deployment.clusterId}) is not known here any more` } as const;
    return { deployment, cluster } as const;
  };

  const logsOrEvents = (kind: 'logs' | 'events'): ToolHandler => async ({ parsed, caller }) => {
    if (!caller.ownerId) return refuse('this run has no owner whose deployments to read');
    const found = await deploymentAndCluster(caller.ownerId, asString(parsed, 'deployment'));
    if ('problem' in found) return refuse(found.problem);
    const text = await read(found.cluster, kind === 'logs' ? logsCommand(found.deployment.namespace) : eventsCommand(found.deployment.namespace));
    const empty = kind === 'logs'
      ? 'No log output. A container that never started has none — get_events says why.'
      : 'No recent events.';
    return answer(`${kind} of ${found.deployment.name} on ${found.cluster.name}`, text || empty);
  };

  return {
    async list_infrastructure({ caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose infrastructure to list');
      const { clusters, deployments } = await world(caller.ownerId);
      if (clusters.length === 0) return answer('no clusters', 'There are no clusters yet.');
      const lines = clusters.map((cluster) => {
        const capacity = cluster.capacity ? `, ${cluster.capacity.cpuCores} cores, ${cluster.capacity.ramGb} GB` : '';
        const gpu = cluster.capacity?.gpuCount ? `, ${cluster.capacity.gpuCount} ${cluster.capacity.gpuVendor ?? ''} GPU` : '';
        const head = `- ${cluster.name} (${cluster.isSystem ? 'the always-on management cluster' : cluster.provider}, ${cluster.status}${capacity}${gpu})`;
        const onIt = deployments.filter((deployment) => deployment.clusterId === cluster.id || deployment.clusterId === cluster.name);
        const apps = onIt.map((deployment) => {
          const why = deployment.record.healthReason ? ` — ${deployment.record.healthReason}` : '';
          return `  - ${deployment.name}: ${deployment.record.appType}, ${deployment.record.status}${why}`;
        });
        return [head, ...(apps.length ? apps : ['  - nothing deployed'])].join('\n');
      });
      return answer(`${clusters.length} clusters, ${deployments.length} deployments`, `Your clusters and what runs on each:\n${lines.join('\n')}`);
    },

    get_logs: logsOrEvents('logs'),
    get_events: logsOrEvents('events'),

    async inspect_resources({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose cluster to read');
      const wantedDeployment = asString(parsed, 'deployment');
      const wantedCluster = asString(parsed, 'cluster');
      let cluster: ClusterMetadata | undefined;
      let namespace: string | undefined;

      if (wantedDeployment) {
        const found = await deploymentAndCluster(caller.ownerId, wantedDeployment);
        if ('problem' in found) return refuse(found.problem);
        cluster = found.cluster;
        namespace = found.deployment.namespace;
      } else if (wantedCluster) {
        const { clusters } = await world(caller.ownerId);
        cluster = clusterNamed(clusters, wantedCluster);
        if (!cluster) return refuse(`you have no cluster called "${wantedCluster}" — yours are: ${clusters.map((entry) => entry.name).join(', ') || 'none'}`);
      } else {
        return refuse('name the deployment to look inside, or the cluster for nodes, volumes and namespaces');
      }

      const plan = planRead({
        verb: asString(parsed, 'verb') ?? 'get',
        resource: asString(parsed, 'resource') ?? '',
        ...(asString(parsed, 'name') ? { name: asString(parsed, 'name') } : {}),
      }, namespace);
      if ('refused' in plan) return refuse(plan.refused);
      const text = await read(cluster, plan.argv);
      return answer(`${plan.argv.join(' ')} on ${cluster.name}`, text || 'Nothing found.');
    },

    async cluster_capacity({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose cluster to read');
      const wantedDeployment = asString(parsed, 'deployment');
      if (wantedDeployment) {
        const found = await deploymentAndCluster(caller.ownerId, wantedDeployment);
        if ('problem' in found) return refuse(found.problem);
        const text = await read(found.cluster, ['top', 'pods', '-n', found.deployment.namespace]);
        return answer(`pod usage of ${found.deployment.name}`, text || 'No usage reported — the metrics server may not be running.');
      }

      const { clusters } = await world(caller.ownerId);
      const wanted = asString(parsed, 'cluster');
      const cluster = wanted ? clusterNamed(clusters, wanted) : clusters.find((entry) => entry.isSystem) ?? clusters[0];
      if (!cluster) return refuse(wanted ? `you have no cluster called "${wanted}"` : 'there are no clusters to measure');
      const [usage, nodes] = await Promise.all([read(cluster, ['top', 'nodes']), read(cluster, ['get', 'nodes', '-o', 'wide'])]);
      return answer(`capacity of ${cluster.name}`, [
        `Node usage on ${cluster.name}:`,
        usage || 'No usage reported — the metrics server may not be running.',
        '',
        'Nodes:',
        nodes || '(none reported)',
      ].join('\n'));
    },
  };
}
