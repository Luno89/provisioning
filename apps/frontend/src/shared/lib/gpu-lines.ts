export interface ReportedGpus {
  gpus?: readonly { model: string; memoryMiB: number; count: number; runtime: boolean }[] | undefined
  gpuProblems?: readonly string[] | undefined
}

export function gpuLines(report: ReportedGpus): string[] {
  const lines = (report.gpus ?? []).filter((gpu) => gpu.count > 0).map((gpu) => {
    const card = `${gpu.count} × ${gpu.model}, ${Math.round(gpu.memoryMiB / 1024)} GiB each`
    return gpu.runtime ? `GPUs: ${card}` : `GPUs: ${card}, not usable yet: NVIDIA's CDI support is not installed`
  })
  const problems = report.gpuProblems ?? []
  return problems.length ? [...lines, `GPUs could not be read: ${problems.join('; ')}`] : lines
}
