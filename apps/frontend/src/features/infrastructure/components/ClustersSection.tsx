import { Cloud, FileText, Plus, Shield, Trash2 } from 'lucide-react'
import { useShellStore } from '../../platform'
import { Bar, Section, StateBadge } from '../../monitoring'
import { useShellContext } from '../hooks/shell-context'
import { QuietButton } from './Parts'
import { clusterCards, healthHash, useInfrastructure } from '../shared'

export function ClustersSection() {
  const ctx = useShellContext()
  const view = useInfrastructure()
  const setConfirmDestroy = useShellStore((s) => s.setConfirmDestroy)
  if (!ctx) return null
  const cards = clusterCards(ctx.clusters, view.data?.monitoring.clusters ?? [])

  return (
    <Section
      id="infrastructure-clusters"
      title={`Clusters · ${cards.length}`}
      right={(
        <button type="button" onClick={() => ctx.setShowClusterModal(true)} className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-500">
          <Plus size={14} /> Provision a cluster
        </button>
      )}
    >
      <p className="text-[11px] text-slate-500">Open one to see everything on it.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map(({ cluster, health }) => (
          <div key={cluster.id} className={`space-y-2 rounded-md border p-3 ${cluster.isSystem ? 'border-purple-500/40 bg-purple-950/20' : 'border-[var(--bark-700)] bg-[var(--bark-900)]/40'}`} data-testid="cluster-card">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <a href={healthHash('cluster', cluster.id)} className="flex items-center gap-1.5 truncate text-[13px] font-semibold text-slate-100 hover:underline">
                  {cluster.isSystem ? <Shield size={13} className="shrink-0 text-purple-300" /> : <Cloud size={13} className="shrink-0 text-blue-300" />}
                  {cluster.name}
                </a>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{cluster.provider}{cluster.isSystem ? ' · system, read-only' : ''}</div>
              </div>
              {health ? <StateBadge state={health.state} /> : <span className="text-[11px] text-slate-400">{cluster.status}</span>}
            </div>
            {health && health.reasons.length > 0 && <p className="text-[11px] text-slate-400">{health.reasons.join('; ')}</p>}
            <Bar label="CPU" share={health?.numbers.cpuShare} />
            <Bar label="Memory" share={health?.numbers.memoryShare} />
            <Bar label="Disk" share={health?.numbers.diskShare} />
            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
              <span>{health ? `${health.apps} app${health.apps === 1 ? '' : 's'} · ${health.history.kept ?? health.history.days} days kept` : ''}</span>
              {!cluster.isSystem && (
                <span className="flex gap-1.5">
                  <QuietButton onClick={() => ctx.openDashboard('cluster', cluster.id)} label={`Logs of ${cluster.name}`}><FileText size={11} /> Logs</QuietButton>
                  <QuietButton danger onClick={() => setConfirmDestroy({ type: 'cluster', id: cluster.id, name: cluster.name, isAbort: cluster.status === 'provisioning' })} label={`Destroy ${cluster.name}`}>
                    <Trash2 size={11} /> {cluster.status === 'provisioning' ? 'Abort' : 'Destroy'}
                  </QuietButton>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

export default ClustersSection
