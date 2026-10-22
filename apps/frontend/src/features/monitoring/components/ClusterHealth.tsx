import { useState, type ReactNode } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import type { Range } from '../api/monitoring'
import { clusterDashboardUrl } from '../../infrastructure'
import { errorMessage } from '../../../api/client'
import { Chart } from './Chart'
import { Bar, EpisodeList, FiringList, HistorySetting, RangePicker, Section, StateBadge } from './Parts'
import { CHARTS, windowOf, healthHash, sectionHash, useClusterHealth } from '../shared'

export function ClusterHealth({ clusterId, standalone = false, actions }: { clusterId: string; standalone?: boolean; actions?: ReactNode }) {
  const [range, setRange] = useState<Range>('24h')
  const health = useClusterHealth(clusterId, range)

  if (health.isPending) return <div className="flex items-center gap-2 p-4 text-[12px] text-slate-400"><Loader2 size={14} className="animate-spin" /> Reading its monitoring…</div>
  if (health.isError) return <p className="p-4 text-[12px] text-rose-300">{errorMessage(health.error)}</p>

  const { cluster, lines, series, firing, episodes, apps } = health.data
  const span = windowOf(health.data.range, health.dataUpdatedAt)
  const n = cluster.numbers
  return (
    <div className="space-y-5 overflow-y-auto p-1" data-testid="cluster-health">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          {standalone && <a href={sectionHash('clusters')} className="text-[11px] text-slate-500 hover:text-slate-300">← Clusters</a>}
          <div className="flex items-center gap-3">
            {standalone && <h2 className="text-lg font-semibold text-slate-100">{cluster.name}</h2>}
            <StateBadge state={cluster.state} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <RangePicker range={range} onPick={setRange} />
          {!cluster.history.byKoala && cluster.history.canChange && (
            <a href={clusterDashboardUrl(cluster.id, 'grafana')} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded border border-[var(--bark-600)] px-2 py-0.5 text-[11px] text-slate-300 hover:bg-[var(--bark-700)]">
              Open in Grafana <ExternalLink size={11} />
            </a>
          )}
        </div>
      </div>

      <FiringList firing={firing} />

      <div className="space-y-0.5 text-[12px] text-slate-300">
        {lines.map((line) => <p key={line}>{line}</p>)}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Bar label="CPU" share={n.cpuShare} />
        <Bar label="Memory" share={n.memoryShare} />
        <Bar label="Disk" share={n.diskShare} />
      </div>

      {series.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-3">
          {series.map((entry) => {
            const chart = CHARTS[entry.chart] ?? { title: entry.chart, unit: 'share' as const }
            return <Chart key={entry.chart} title={chart.title} unit={chart.unit} points={entry.points} {...span} />
          })}
        </div>
      )}

      <Section title="Apps on it">
        {apps.length ? (
          <ul className="space-y-1">
            {apps.map((app) => (
              <li key={app.id} className="flex items-center gap-3 text-[12px]">
                <a href={healthHash('app', app.id)} className="flex-1 text-slate-200 hover:underline">{app.name}</a>
                <StateBadge state={app.state} />
              </li>
            ))}
          </ul>
        ) : <p className="text-[11px] text-slate-500">None of your apps run here.</p>}
      </Section>

      <Section title="Alert history">
        <EpisodeList episodes={episodes} />
      </Section>

      <HistorySetting key={`${cluster.id}:${cluster.history.days}`} clusterId={cluster.id} history={cluster.history} />
    </div>
  )
}

export default ClusterHealth
