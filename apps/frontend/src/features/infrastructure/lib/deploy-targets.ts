import type { Cluster } from '../types/cluster'

export const deployableTo = (cluster: Pick<Cluster, 'status' | 'provider'>): boolean =>
  cluster.status === 'healthy' || (cluster.provider === 'machine' && cluster.status === 'stopped')

export const reportsGpu = (cluster: Pick<Cluster, 'gpus'>): boolean => (cluster.gpus ?? []).some((gpu) => gpu.count > 0)

export const gpusOf = (cluster: Pick<Cluster, 'gpus'>): string =>
  (cluster.gpus ?? []).filter((gpu) => gpu.count > 0).map((gpu) => `${gpu.count} × ${gpu.model}`).join(', ')

export const targetLabel = (cluster: Pick<Cluster, 'name' | 'provider' | 'status' | 'gpus'>): string => {
  const gpu = reportsGpu(cluster) ? ` • ${gpusOf(cluster)}` : ''
  if (cluster.provider === 'machine') return `${cluster.name} (my machine${cluster.status === 'stopped' ? ', started when this deploys' : ''}${gpu})`
  return `${cluster.name} (${cluster.provider}${gpu})`
}
