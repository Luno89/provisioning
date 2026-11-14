/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `gpuDeployRefusal` in apps/backend/src/infrastructure/lib/cluster-gpus.ts, which refuses a deploy with these words.
 */

export type GpuVendor = 'nvidia' | 'amd'

interface ReportedGpu { vendor: string; model: string; count: number; runtime: boolean }

export interface GpuReport {
  name: string
  provider: string
  gpus?: readonly ReportedGpu[] | undefined
  gpuProblems?: readonly string[] | undefined
}

export interface VendorChoice { vendor: GpuVendor; label: string; counts: string[] }

export interface GpuChoices { vendors: VendorChoice[]; problem?: string }

const VENDORS: readonly { vendor: GpuVendor; label: string }[] = [{ vendor: 'nvidia', label: 'NVIDIA' }, { vendor: 'amd', label: 'AMD' }]

const CDI_HINT = 'Run the command from My Machines again on it, which offers to install it (the NVIDIA Container Toolkit\'s base package).'

const plural = (count: number, label: string): string => `${count} ${label} GPU${count === 1 ? '' : 's'}`

const countOf = (gpus: readonly ReportedGpu[], vendor: GpuVendor, usable: boolean): number =>
  gpus.filter((gpu) => gpu.vendor === vendor && (!usable || gpu.runtime)).reduce((sum, gpu) => sum + gpu.count, 0)

export interface ServerNeeds { runsOn?: readonly GpuVendor[]; runsOnCpu?: boolean }

export function gpuChoicesOf(cluster: GpuReport, { runsOn = ['nvidia', 'amd'], runsOnCpu = true }: ServerNeeds = {}): GpuChoices {
  const until = runsOnCpu ? ' Until then it runs this on CPU only.' : ' It cannot run there until then.'
  const refused = (why: string): GpuChoices => ({ vendors: [], problem: `${why}${until}` })
  if (cluster.provider !== 'machine') return refused(`Only a machine's own cluster runs apps on GPUs, and ${cluster.name} is not one.`)
  if (!cluster.gpus) return refused(`${cluster.name} has not said which GPUs it has: its agent is from before GPUs were reported, or it has not connected since. Once it connects with a current agent, it says.`)
  const { gpus } = cluster
  if (gpus.length === 0) return refused(`${cluster.name} shows no GPU: ${cluster.gpuProblems?.length ? cluster.gpuProblems.join('; ') : 'if it has one, install its driver so nvidia-smi or the AMD kernel driver answers, then reconnect its agent'}.`)
  const offered = VENDORS.filter((entry) => runsOn.includes(entry.vendor))
  const vendors = offered.flatMap(({ vendor, label }) => {
    const usable = countOf(gpus, vendor, true)
    return usable > 0 ? [{ vendor, label, counts: Array.from({ length: usable }, (_, at) => String(at + 1)) }] : []
  })
  if (vendors.length) return { vendors }
  const present = offered.find(({ vendor }) => countOf(gpus, vendor, false) > 0)
  if (present) return refused(`${cluster.name} has ${plural(countOf(gpus, present.vendor, false), present.label)}, and pods there cannot be given them yet: NVIDIA's CDI support is not installed. ${CDI_HINT}`)
  return refused(`${cluster.name} has no ${offered.map((entry) => entry.label).join(' or ')} GPU (it has ${gpus.map((gpu) => `${gpu.count} × ${gpu.model}`).join(', ')}).`)
}

export function chosenGpus(choices: GpuChoices, asked: { vendor: GpuVendor; count: string }, runsOnCpu = true): { vendor: GpuVendor; count: string } {
  const vendor = choices.vendors.find((choice) => choice.vendor === asked.vendor) ?? choices.vendors[0]
  if (runsOnCpu && asked.count === '0') return { vendor: vendor?.vendor ?? asked.vendor, count: '0' }
  if (vendor?.counts.includes(asked.count)) return { vendor: vendor.vendor, count: asked.count }
  return { vendor: vendor?.vendor ?? asked.vendor, count: vendor?.counts[0] ?? (runsOnCpu ? '0' : '') }
}
