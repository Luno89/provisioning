import { randomUUID } from 'node:crypto';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { AccessRequest } from '@koala/harness-types';
import type { ClusterMetadata, DeploymentMetadata } from '../../lib/types.js';
import {
  LOG_TAIL, PLATFORM_NAMESPACES, eventsCommand, findDeployment, logsCommand, namespaceOf, namespacesProblem, planRead, trimOutput,
  type OwnedDeployment,
} from '../../lib/kube-diagnostics.js';

export interface KubeAccess {
  clusters(ownerId: string): Promise<ClusterMetadata[]>;
  deployments(): Promise<DeploymentMetadata[]>;
  kubectl(cluster: ClusterMetadata, argv: string[]): Promise<string>;
  isAdmin(ownerId: string): Promise<boolean>;
  openNamespaces(ownerId: string, conversationId: string): Promise<string[]>;
  accessRequests: {
    list(ownerId: string, conversationId: string): Promise<AccessRequest[]>;
    save(request: AccessRequest): Promise<void>;
  };
}

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });
const answer = (digest: string, content: string): ToolOutcome => ({ ok: true, digest, content });

export function createKubeTools(options: { access: KubeAccess; now?: (() => string) | undefined; newId?: (() => string) | undefined }): Record<string, ToolHandler> {
  const { access } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? randomUUID;

  const platform = async (ownerId: string, conversationId: string | undefined, namespace: string) => {
    if (!(PLATFORM_NAMESPACES as readonly string[]).includes(namespace)) return { problem: `${namespace} is not a platform namespace — for your own deployments, name the deployment` } as const;
    const open = conversationId ? await access.openNamespaces(ownerId, conversationId) : [];
    if (!open.includes(namespace)) return { problem: `${namespace} is not open in this conversation — request_cluster_access asks an admin to open it` } as const;
    const cluster = (await access.clusters(ownerId)).find((entry) => entry.isSystem);
    if (!cluster) return { problem: 'the management cluster is not known here' } as const;
    return { cluster, namespace } as const;
  };

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
    const namespace = asString(parsed, 'namespace');
    if (namespace) {
      const opened = await platform(caller.ownerId, caller.conversationId, namespace);
      if ('problem' in opened) return refuse(opened.problem);
      const name = asString(parsed, 'name');
      if (kind === 'logs' && !name) return refuse(`name the pod or workload to read in ${namespace}, like deployment/grafana — inspect_resources lists them`);
      if (kind === 'logs' && !/^[a-z0-9][a-z0-9./-]{0,252}$/i.test(name!)) return refuse(`"${name}" is not a valid name`);
      const argv = kind === 'logs'
        ? ['logs', '-n', namespace, name!, '--all-containers', '--prefix', '--tail', String(LOG_TAIL)]
        : eventsCommand(namespace);
      const text = await read(opened.cluster, argv);
      return answer(`${kind} in ${namespace}`, text || (kind === 'logs' ? 'No log output.' : 'No recent events.'));
    }
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
      const wantedNamespace = asString(parsed, 'namespace');
      let cluster: ClusterMetadata | undefined;
      let namespace: string | undefined;

      if (wantedNamespace) {
        const opened = await platform(caller.ownerId, caller.conversationId, wantedNamespace);
        if ('problem' in opened) return refuse(opened.problem);
        cluster = opened.cluster;
        namespace = opened.namespace;
      } else if (wantedDeployment) {
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

    async request_cluster_access({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to ask for');
      if (!caller.conversationId) return refuse('platform namespaces open for a conversation, and this run is part of none');
      if (!(await access.isAdmin(caller.ownerId))) return refuse('only an administrator can open the platform\'s own namespaces; your own deployments are readable already');
      const raw = parsed.namespaces;
      const namespaces = [...new Set((Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []).map((entry) => String(entry).trim()).filter(Boolean))];
      const problem = namespacesProblem(namespaces);
      if (problem) return refuse(problem);
      const why = asString(parsed, 'why');
      if (!why) return refuse('say what you need to look at there and why');

      const open = await access.openNamespaces(caller.ownerId, caller.conversationId);
      const wanted = namespaces.filter((namespace) => !open.includes(namespace));
      if (wanted.length === 0) return answer('already open', `${namespaces.join(', ')} ${namespaces.length === 1 ? 'is' : 'are'} already open in this conversation.`);
      const waiting = (await access.accessRequests.list(caller.ownerId, caller.conversationId))
        .find((request) => request.status === 'requested' && wanted.every((namespace) => request.namespaces.includes(namespace)));
      if (waiting) return answer('already asked', `Already asked to open ${waiting.namespaces.join(', ')}; nothing new was asked.`);

      const stamp = now();
      await access.accessRequests.save({
        id: newId(), ownerId: caller.ownerId, conversationId: caller.conversationId, namespaces: wanted, why, status: 'requested',
        ...(caller.runId ? { runId: caller.runId } : {}), createdAt: stamp, updatedAt: stamp,
      });
      return answer(`asked to open ${wanted.join(', ')}`, `Asked to open ${wanted.join(', ')} for this conversation. Once approved, name them as namespace in the diagnostics — read-only, and Secrets stay closed.`);
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
