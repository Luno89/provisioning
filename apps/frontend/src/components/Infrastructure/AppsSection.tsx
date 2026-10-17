import { ExternalLink, Plus, Settings2, Shield, Trash2 } from 'lucide-react'
import { deployStatusClass } from '../../lib/deploy-status'
import { NO_WEB_UI_APP_TYPES } from '../../lib/app-ui'
import { useShellStore } from '../../stores/shell'
import { Section, StateBadge } from '../Monitoring/Parts'
import { useShellContext } from '../shell-context'
import { QuietButton } from './Parts'
import { appRows, bytes, healthHash, percent, rate, seconds, useInfrastructure } from './shared'

export function AppsSection() {
  const ctx = useShellContext()
  const view = useInfrastructure()
  const setConfirmDestroy = useShellStore((s) => s.setConfirmDestroy)
  if (!ctx) return null
  const rows = appRows(ctx.deployments, view.data?.monitoring.apps ?? [])
  const clusterName = (id: string) => ctx.clusters.find((cluster) => cluster.id === id)?.name ?? 'a cluster that is gone'

  return (
    <Section
      id="infrastructure-apps"
      title={`Apps${rows.length ? ` · ${rows.length}` : ''}`}
      right={(
        <button type="button" onClick={() => ctx.setShowAppModal(true)} className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-500">
          <Plus size={14} /> Deploy an app
        </button>
      )}
    >
      {rows.length ? (
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
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ deployment: app, health }) => (
                <tr key={app.id} className="border-t border-[var(--bark-700)] align-top" data-testid="app-row">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded border border-[var(--bark-600)] px-1.5 text-[10px] uppercase text-slate-400">{app.appType || 'odoo'}</span>
                      <a href={healthHash('app', app.id)} className="font-semibold text-slate-100 hover:underline">{app.name}</a>
                      {app.vpnEnabled && <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-300"><Shield size={10} /> VPN</span>}
                    </div>
                    <div className="text-[11px] text-slate-500">{clusterName(app.clusterId)} · {app.strategy || 'helm'}</div>
                    {app.status === 'running' && app.url && !NO_WEB_UI_APP_TYPES.has(app.appType || '') && (
                      <a href={app.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-blue-300 hover:underline">Open <ExternalLink size={10} /></a>
                    )}
                    {app.isExposed && app.exposureUrl && (
                      <a href={app.exposureUrl + (app.exposurePath || '')} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 text-[11px] text-emerald-300 hover:underline">
                        {app.exposureUrl}{app.exposurePath || ''} <ExternalLink size={10} />
                      </a>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {health ? <StateBadge state={health.state} /> : <span title={app.healthReason || undefined} className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${deployStatusClass(app.status)}`}>{app.status}</span>}
                    {health && health.reasons.length > 0 && <div className="mt-0.5 max-w-[16rem] text-[11px] text-slate-500">{health.reasons.join('; ')}</div>}
                  </td>
                  <td className="px-3 py-2 text-slate-300">{percent(health?.numbers.uptimeDay)}</td>
                  <td className="px-3 py-2 text-slate-300">{seconds(health?.numbers.responseSeconds)}</td>
                  <td className="px-3 py-2 text-slate-300">{health ? rate(health.numbers.requestsPerSecond) : '—'}</td>
                  <td className="px-3 py-2 text-slate-300">{health?.memoryShare !== undefined ? percent(health.memoryShare) : bytes(health?.numbers.memoryBytes)}</td>
                  <td className="px-3 py-2 text-slate-300">{percent(health?.cpuShare)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1.5">
                      <QuietButton onClick={() => ctx.openDashboard('app', app.id)} label={`Manage ${app.name}`}><Settings2 size={11} /> Manage</QuietButton>
                      <QuietButton danger onClick={() => setConfirmDestroy({ type: 'app', id: app.id, name: app.name, isAbort: app.status === 'deploying' })} label={`Destroy ${app.name}`}><Trash2 size={11} /> {app.status === 'deploying' ? 'Abort' : 'Destroy'}</QuietButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-[12px] text-slate-500">You have no apps deployed. Deploy one, or ask Koala.</p>}
    </Section>
  )
}

export default AppsSection
