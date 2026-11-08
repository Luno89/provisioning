import type { Cluster } from '../types/cluster'

export const deployableTo = (cluster: Pick<Cluster, 'status' | 'provider'>): boolean =>
  cluster.status === 'healthy' || (cluster.provider === 'machine' && cluster.status === 'stopped')

export const reportsGpu = (cluster: Pick<Cluster, 'capacity'>): boolean => (cluster.capacity?.gpuCount ?? 0) > 0

export const targetLabel = (cluster: Pick<Cluster, 'name' | 'provider' | 'status' | 'capacity'>): string => {
  const gpu = reportsGpu(cluster) ? ' • GPU' : ''
  if (cluster.provider === 'machine') return `${cluster.name} (my machine${cluster.status === 'stopped' ? ', started when this deploys' : ''}${gpu})`
  return `${cluster.name} (${cluster.provider}${gpu})`
}
