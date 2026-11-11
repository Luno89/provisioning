import type { Cluster } from '../types/cluster'

export function gpuLines(cluster: Pick<Cluster, 'gpus' | 'gpuProblems'>): string[] {
  const lines = (cluster.gpus ?? []).filter((gpu) => gpu.count > 0).map((gpu) => {
    const card = `${gpu.count} × ${gpu.model}, ${Math.round(gpu.memoryMiB / 1024)} GiB each`
    return gpu.runtime ? `GPUs: ${card}` : `GPUs: ${card}, not usable yet: the NVIDIA Container Toolkit is not installed`
  })
  const problems = cluster.gpuProblems ?? []
  return problems.length ? [...lines, `GPUs could not be read: ${problems.join('; ')}`] : lines
}
