import { useParams } from '@tanstack/react-router'
import { Server, Settings2, Trash2 } from 'lucide-react'
import { useShellStore } from '../../stores/shell'
import { AppHealth } from '../Monitoring/AppHealth'
import { useShellContext } from '../shell-context'
import { AppsTab } from './AppsTab'
import { ClusterPage } from './ClusterPage'
import { ClustersTab } from './ClustersTab'
import { Overview } from './Overview'
import { QuietButton } from './Parts'
import RunningTab from './RunningTab'
import { useRunning } from './useRunning'
import { TABS, isTab, tabHash, useInfrastructure, type TabId } from './shared'

function AppPage({ deploymentId }: { deploymentId: string }) {
  const ctx = useShellContext()
  const setConfirmDestroy = useShellStore((s) => s.setConfirmDestroy)
  const app = ctx?.deployments.find((entry) => entry.id === deploymentId)
  const actions = app && ctx ? (
    <>
      <QuietButton onClick={() => ctx.openDashboard('app', app.id)}><Settings2 size={11} /> Manage</QuietButton>
      <QuietButton danger onClick={() => setConfirmDestroy({ type: 'app', id: app.id, name: app.name, isAbort: app.status === 'deploying' })}><Trash2 size={11} /> {app.status === 'deploying' ? 'Abort' : 'Destroy'}</QuietButton>
    </>
  ) : undefined
  return <AppHealth deploymentId={deploymentId} standalone actions={actions} />
}

function TabBar({ current }: { current: TabId }) {
  const running = useRunning().data?.items.length ?? 0
  const attention = useInfrastructure().data
  const needs = attention ? attention.monitoring.attention.length + attention.workloads.length + attention.waiting.length + attention.failures.length : 0
  return (
    <nav className="flex gap-1 border-b border-[var(--bark-700)]" aria-label="Infrastructure">
      {TABS.map((tab) => (
        <a
          key={tab.id}
          href={tabHash(tab.id)}
          aria-current={tab.id === current ? 'page' : undefined}
          className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12px] ${tab.id === current ? 'border-[var(--leaf)] text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
        >
          {tab.label}
          {tab.id === 'overview' && needs > 0 && <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] text-amber-200" aria-label={`${needs} need attention`}>{needs}</span>}
          {tab.id === 'running' && running > 0 && <span className="rounded-full bg-[var(--bark-600)] px-1.5 text-[10px] text-slate-200" aria-label={`${running} running`}>{running}</span>}
        </a>
      ))}
    </nav>
  )
}

export function InfrastructureView() {
  const params = useParams({ strict: false }) as { tab?: string; kind?: string; id?: string }
  const detail = (params.kind === 'app' || params.kind === 'cluster') && params.id ? { kind: params.kind, id: params.id } : undefined
  const current: TabId = detail ? (detail.kind === 'app' ? 'apps' : 'clusters') : isTab(params.tab) ? params.tab : 'overview'

  return (
    <div className="h-full overflow-y-auto p-6" data-testid="infrastructure-view">
      <div className="mx-auto max-w-6xl space-y-5">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-100"><Server size={17} className="text-[var(--leaf)]" /> Infrastructure</h1>
        <TabBar current={current} />
        {detail?.kind === 'app' ? <AppPage deploymentId={detail.id} />
          : detail?.kind === 'cluster' ? <ClusterPage clusterId={detail.id} />
          : current === 'apps' ? <AppsTab />
          : current === 'clusters' ? <ClustersTab />
          : current === 'running' ? <RunningTab />
          : <Overview />}
      </div>
    </div>
  )
}

export default InfrastructureView
