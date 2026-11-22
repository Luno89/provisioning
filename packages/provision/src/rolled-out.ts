import { until, type Judge } from '@koala/engine-core/until';
import { informers, type ClusterWatch, type Listed, type Resource } from './informer.js';

const WORKLOAD_KINDS = [
  { api: '/apis/apps/v1', plural: 'deployments', kind: 'Deployment' },
  { api: '/apis/apps/v1', plural: 'statefulsets', kind: 'StatefulSet' },
  { api: '/apis/apps/v1', plural: 'daemonsets', kind: 'DaemonSet' },
  { api: '/apis/apps/v1', plural: 'replicasets', kind: 'ReplicaSet' },
  { api: '/apis/batch/v1', plural: 'jobs', kind: 'Job' },
  { api: '/api/v1', plural: 'pods', kind: 'Pod' },
] as const;

export function workloadResources(namespace: string, labelSelector: string): Resource[] {
  return WORKLOAD_KINDS.map(({ api, plural, kind }) => ({ kind, path: `${api}/namespaces/${encodeURIComponent(namespace)}/${plural}`, labelSelector }));
}

export function rolledOut<R>(cluster: ClusterWatch, what: string, resources: readonly Resource[], judge: Judge<Listed, R>, say?: (waiting: string) => void): Promise<R> {
  return until(what, informers(cluster, resources), judge, say);
}
