import { useParams } from '@tanstack/react-router'
import { Server, Settings2, Trash2 } from 'lucide-react'
import { formatHash } from '../../features/platform'
import { useShellStore } from '../../features/platform'
import { AppHealth } from '../Monitoring/AppHealth'
import { useShellContext } from '../shell-context'
import { ClusterPage } from './ClusterPage'
import { Overview } from './Overview'
import { QuietButton } from './Parts'
import { isSection } from './shared'

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

export function InfrastructureView() {
  const params = useParams({ strict: false }) as { tab?: string; kind?: string; id?: string }
  const detail = (params.kind === 'app' || params.kind === 'cluster') && params.id ? { kind: params.kind, id: params.id } : undefined
  const title = <><Server size={17} className="text-[var(--leaf)]" /> Infrastructure</>

  return (
    <div className="h-full overflow-y-auto p-6" data-testid="infrastructure-view">
      <div className="mx-auto max-w-6xl space-y-6">
        <h1 className="text-lg font-semibold text-slate-100">
          {detail ? <a href={formatHash('infrastructure', [])} className="flex items-center gap-2 hover:underline">{title}</a> : <span className="flex items-center gap-2">{title}</span>}
        </h1>
        {detail?.kind === 'app' ? <AppPage deploymentId={detail.id} />
          : detail?.kind === 'cluster' ? <ClusterPage clusterId={detail.id} />
          : <Overview {...(isSection(params.tab) ? { focus: params.tab } : {})} />}
      </div>
    </div>
  )
}

export default InfrastructureView
