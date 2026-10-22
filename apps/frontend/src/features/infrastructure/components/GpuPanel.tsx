import { Loader2, Zap } from 'lucide-react'
import { useGpuStatus } from '../api/clusters'
import { Section } from '../../../components/Monitoring/Parts'

export function GpuPanel({ clusterId, passthrough }: { clusterId: string; passthrough: boolean }) {
  const gpu = useGpuStatus(clusterId)
  if (gpu.isPending) return <Section title="GPUs"><Loader2 size={12} className="animate-spin text-slate-500" /></Section>
  const status = gpu.data
  if (status === null) return null
  if (!status) return <Section title="GPUs"><p className="text-[11px] text-slate-500">GPU status could not be read.</p></Section>
  const enabled = passthrough || status.passthroughEnabled
  const total = status.totalCapacity ?? 0
  if (!total && !enabled) return <Section title="GPUs"><p className="text-[11px] text-slate-500">No GPUs, and passthrough is off.</p></Section>

  return (
    <Section title="GPUs">
      <div className="space-y-2 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3 text-[12px]" data-testid="gpu-panel">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 font-semibold text-slate-200"><Zap size={12} className="text-amber-400" /> {status.vendor !== 'none' ? `${status.vendor} GPUs` : 'GPUs'}</span>
          <span className="text-slate-400">passthrough {enabled ? 'on' : 'off'}</span>
          {total > 0
            ? <span className={(status.availableGpus ?? 0) > 0 ? 'text-emerald-300' : 'text-rose-300'}>{status.availableGpus} of {status.totalAllocatable} free</span>
            : <span className="text-amber-300">no GPU found on the node</span>}
        </div>
        {total > 0 && (
          <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
            <div><div className="text-slate-500">Capacity</div><div className="text-slate-200">{status.totalCapacity}</div></div>
            <div><div className="text-slate-500">Allocatable</div><div className="text-slate-200">{status.totalAllocatable}</div></div>
            <div><div className="text-slate-500">In use</div><div className="text-amber-300">{status.totalAllocated}</div></div>
            <div><div className="text-slate-500">Free</div><div className="text-slate-200">{status.availableGpus}</div></div>
          </div>
        )}
        {(status.devicePlugins ?? []).map((plugin) => (
          <div key={plugin.name} className="flex justify-between text-[11px]">
            <span className="font-mono text-slate-300">{plugin.name}</span>
            <span className={plugin.status === 'active' ? 'text-emerald-300' : 'text-amber-300'}>{plugin.status === 'active' ? 'active' : 'degraded'}, {plugin.readyPods}/{plugin.desiredPods} ready</span>
          </div>
        ))}
        {(status.gpuPods ?? []).map((pod) => (
          <div key={`${pod.namespace}/${pod.name}`} className="flex justify-between text-[11px]">
            <span className="text-slate-300"><span className="text-amber-300">{pod.gpus} GPU</span> {pod.name} <span className="font-mono text-slate-500">({pod.namespace})</span></span>
            <span className={pod.status === 'Running' ? 'text-emerald-300' : 'text-amber-300'}>{pod.status}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

export default GpuPanel
