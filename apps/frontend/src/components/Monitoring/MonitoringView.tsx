import { useParams } from '@tanstack/react-router'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { ago } from '../home-summary'
import { AppHealth } from './AppHealth'
import { ClusterHealth } from './ClusterHealth'
import { Bar, EpisodeList, FiringList, RuleList, Section, StateBadge } from './Parts'
import { bytes, monitoringHash, percent, rate, seconds, useAlerts, useOverview } from './shared'

export function MonitoringView() {
  const { kind, id } = useParams({ strict: false }) as { kind?: string; id?: string }
  return (
    <div className="h-full overflow-y-auto p-6" data-testid="monitoring-view">
      {kind === 'app' && id ? <AppHealth deploymentId={id} standalone />
        : kind === 'cluster' && id ? <ClusterHealth clusterId={id} standalone />
        : <Overview />}
    </div>
  )
}

function Overview() {
  const overview = useOverview()
  const alerts = useAlerts()

  if (overview.isPending) return <div className="flex items-center gap-2 text-[12px] text-slate-400"><Loader2 size={14} className="animate-spin" /> Reading every cluster's monitoring…</div>
  if (overview.isError) return <p className="text-[12px] text-rose-300">{errorMessage(overview.error)}</p>

  const { attention, apps, clusters, firing, checkedAt } = overview.data
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-slate-100">Monitoring</h2>
        <span className="text-[11px] text-slate-500">checked {ago(checkedAt)}</span>
      </header>

      <Section title="Needs attention">
        {attention.length ? (
          <ul className="space-y-1.5" aria-label="Needs attention">
            {attention.map((item) => (
              <li key={`${item.subject.kind}:${item.subject.id}`}>
                <a href={monitoringHash(item.subject.kind, item.subject.id)} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 px-3 py-2 text-[12px] hover:bg-[var(--bark-800)]">
                  <StateBadge state={item.state} />
                  <span className="font-semibold text-slate-100">{item.subject.name}</span>
                  <span className="text-slate-400">{item.reasons.join('; ')}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-[12px] text-emerald-300"><CheckCircle2 size={14} /> Everything is healthy.</p>
        )}
        <FiringList firing={firing} />
      </Section>

      <Section title="Apps">
        {apps.length ? (
          <div className="overflow-x-auto rounded-md border border-[var(--bark-700)]">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-[var(--bark-900)] text-[11px] text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">App</th>
                  <th className="px-3 py-2 font-medium">State</th>
                  <th className="px-3 py-2 font-medium">Up, day</th>
                  <th className="px-3 py-2 font-medium">Response</th>
                  <th className="px-3 py-2 font-medium">Requests</th>
                  <th className="px-3 py-2 font-medium">Memory</th>
                  <th className="px-3 py-2 font-medium">CPU</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => (
                  <tr key={app.id} className="border-t border-[var(--bark-700)]" data-testid="monitoring-app-row">
                    <td className="px-3 py-2">
                      <a href={monitoringHash('app', app.id)} className="font-semibold text-slate-100 hover:underline">{app.name}</a>
                      <div className="text-[11px] text-slate-500">{app.clusterName}</div>
                    </td>
                    <td className="px-3 py-2"><StateBadge state={app.state} /></td>
                    <td className="px-3 py-2 text-slate-300">{percent(app.numbers.uptimeDay)}</td>
                    <td className="px-3 py-2 text-slate-300">{seconds(app.numbers.responseSeconds)}</td>
                    <td className="px-3 py-2 text-slate-300">{rate(app.numbers.requestsPerSecond)}</td>
                    <td className="px-3 py-2 text-slate-300">{app.memoryShare !== undefined ? percent(app.memoryShare) : bytes(app.numbers.memoryBytes)}</td>
                    <td className="px-3 py-2 text-slate-300">{percent(app.cpuShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-[12px] text-slate-500">You have no apps deployed.</p>}
      </Section>

      <Section title="Clusters">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {clusters.map((cluster) => (
            <a key={cluster.id} href={monitoringHash('cluster', cluster.id)} className="block space-y-2 rounded-md border border-[var(--bark-700)] bg-[var(--bark-900)]/40 p-3 hover:bg-[var(--bark-800)]" data-testid="monitoring-cluster-card">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12px] font-semibold text-slate-100">{cluster.name}</span>
                <StateBadge state={cluster.state} />
              </div>
              {cluster.reasons.length > 0 && <p className="text-[11px] text-slate-400">{cluster.reasons.join('; ')}</p>}
              <Bar label="CPU" share={cluster.numbers.cpuShare} />
              <Bar label="Memory" share={cluster.numbers.memoryShare} />
              <Bar label="Disk" share={cluster.numbers.diskShare} />
              <div className="flex justify-between text-[11px] text-slate-500">
                <span>{cluster.apps} app{cluster.apps === 1 ? '' : 's'}</span>
                <span>{cluster.history.kept ?? cluster.history.days} days kept</span>
              </div>
            </a>
          ))}
        </div>
      </Section>

      <Section title="Alerts set">
        {alerts.data ? <RuleList rules={alerts.data.rules} /> : <Loader2 size={12} className="animate-spin text-slate-500" />}
      </Section>
      <Section title="Alert history">
        {alerts.data ? <EpisodeList episodes={alerts.data.episodes} /> : <Loader2 size={12} className="animate-spin text-slate-500" />}
      </Section>
    </div>
  )
}

export default MonitoringView
