import { useState, type ReactNode } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import type { Range } from '../api/monitoring'
import { clusterDashboardUrl } from '../../infrastructure'
import { errorMessage } from '../../../api/client'
import { Chart } from './Chart'
import { EpisodeList, FiringList, RangePicker, RuleList, Section, StateBadge } from './Parts'
import { CHARTS, windowOf, bytes, healthHash, sectionHash, percent, rate, seconds, useAppHealth } from '../shared'

export function AppHealth({ deploymentId, standalone = false, actions }: { deploymentId: string; standalone?: boolean; actions?: ReactNode }) {
  const [range, setRange] = useState<Range>('24h')
  const health = useAppHealth(deploymentId, range)

  if (health.isPending) return <div className="flex items-center gap-2 p-4 text-[12px] text-slate-400"><Loader2 size={14} className="animate-spin" /> Reading its monitoring…</div>
  if (health.isError) return <p className="p-4 text-[12px] text-rose-300">{errorMessage(health.error)}</p>

  const { app, lines, series, markers, firing, episodes, rules, history } = health.data
  const span = windowOf(health.data.range, health.dataUpdatedAt)
  const n = app.numbers
  return (
    <div className="space-y-5 overflow-y-auto p-1" data-testid="app-health">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          {standalone && <a href={sectionHash('apps')} className="text-[11px] text-slate-500 hover:text-slate-300">← Apps</a>}
          <div className="flex items-center gap-3">
            {standalone && <h2 className="text-lg font-semibold text-slate-100">{app.name}</h2>}
            <StateBadge state={app.state} />
            <a href={healthHash('cluster', app.clusterId)} className="text-[11px] text-slate-500 hover:text-slate-300">on {app.clusterName}</a>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <RangePicker range={range} onPick={setRange} />
          {!history.byKoala && history.canChange && (
            <a href={clusterDashboardUrl(app.clusterId, 'grafana')} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded border border-[var(--bark-600)] px-2 py-0.5 text-[11px] text-slate-300 hover:bg-[var(--bark-700)]">
              Open in Grafana <ExternalLink size={11} />
            </a>
          )}
        </div>
      </div>

      <FiringList firing={firing} />

      <div className="space-y-0.5 text-[12px] text-slate-300">
        {lines.map((line) => <p key={line}>{line}</p>)}
      </div>

      <dl className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
        <Stat label="Up, last day" value={percent(n.uptimeDay)} />
        <Stat label="Up, last week" value={percent(n.uptimeWeek)} />
        <Stat label="Response time" value={seconds(n.responseSeconds)} />
        <Stat label="Requests" value={rate(n.requestsPerSecond)} />
        <Stat label="Failing" value={n.errorShare === undefined ? 'not counted' : percent(n.errorShare)} />
        <Stat label="Memory" value={`${bytes(n.memoryBytes)}${app.memoryShare !== undefined ? ` (${percent(app.memoryShare)})` : ''}`} />
        <Stat label="CPU" value={app.cpuShare !== undefined ? percent(app.cpuShare) : n.cpuCores !== undefined ? `${n.cpuCores.toFixed(2)} cores` : '—'} />
        <Stat label="Restarts, last day" value={n.restartsDay === undefined ? '—' : String(Math.round(n.restartsDay))} />
      </dl>

      {series.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {series.map((entry) => {
            const chart = CHARTS[entry.chart] ?? { title: entry.chart, unit: 'share' as const }
            return <Chart key={entry.chart} title={chart.title} unit={chart.unit} points={entry.points} markers={markers} {...span} />
          })}
        </div>
      ) : (
        <p className="text-[12px] text-slate-500">No measurements in this range yet.</p>
      )}
      {markers.length > 0 && <p className="text-[11px] text-slate-500">Dashed lines: {markers.map((marker) => marker.label).join(', ')}.</p>}

      <Section title="Alerts set">
        <RuleList rules={rules} />
      </Section>
      <Section title="Alert history">
        <EpisodeList episodes={episodes} />
      </Section>
      <p className="text-[11px] text-slate-500">Its cluster keeps {history.kept ?? history.days} days of history.</p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 px-3 py-2">
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className="text-[13px] font-semibold text-slate-100">{value}</dd>
    </div>
  )
}

export default AppHealth
