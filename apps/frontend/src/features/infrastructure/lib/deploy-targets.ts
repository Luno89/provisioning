import type { Cluster } from '../types/cluster'

export const deployableTo = (cluster: Pick<Cluster, 'status' | 'provider'>): boolean =>
  cluster.status === 'healthy' || (cluster.provider === 'machine' && cluster.status === 'stopped')

export const targetLabel = (cluster: Pick<Cluster, 'name' | 'provider' | 'status' | 'gpuEnabled'>): string => {
  if (cluster.provider === 'machine') return `${cluster.name} (my machine${cluster.status === 'stopped' ? ', started when this deploys' : ''})`
  return `${cluster.name} (${cluster.provider}${cluster.gpuEnabled ? ' • GPU' : ''})`
}
