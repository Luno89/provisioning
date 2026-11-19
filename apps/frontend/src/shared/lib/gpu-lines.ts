import { GPU_VENDOR_LABELS, type GpuWithoutDriver } from '@koala/engine-core/machine-gpus'

export interface ReportedGpus {
  gpus?: readonly { model: string; memoryMiB: number; count: number; runtime: boolean }[] | undefined
  gpuProblems?: readonly string[] | undefined
  gpusWithoutDriver?: readonly GpuWithoutDriver[] | undefined
}

export function gpuLines(report: ReportedGpus): string[] {
  const lines = (report.gpus ?? []).filter((gpu) => gpu.count > 0).map((gpu) => {
    const card = `${gpu.count} × ${gpu.model}, ${Math.round(gpu.memoryMiB / 1024)} GiB each`
    return gpu.runtime ? `GPUs: ${card}` : `GPUs: ${card}, not usable yet: NVIDIA's CDI support is not installed`
  })
  const bare = (report.gpusWithoutDriver ?? []).map((gpu) => `GPUs: ${gpu.count} × ${GPU_VENDOR_LABELS[gpu.vendor]} ${gpu.device}, ${gpu.count === 1 ? 'its' : 'their'} driver is not installed`)
  const problems = report.gpuProblems ?? []
  return problems.length ? [...lines, ...bare, `GPUs could not be read: ${problems.join('; ')}`] : [...lines, ...bare]
}
