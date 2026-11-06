import { Loader2 } from 'lucide-react'
import { errorMessage } from '../../../api/client'
import { RootKoala } from '../../infrastructure'
import { ClusterHealth, useOverview } from '../../monitoring'

export function RootMonitoring() {
  const overview = useOverview()
  const root = overview.data?.clusters.find((cluster) => cluster.isSystem)

  return (
    <section id="monitoring" className="space-y-3" aria-labelledby="monitoring-heading">
      <h2 id="monitoring-heading" className="text-sm font-semibold">Root's health</h2>
      <p className="text-xs text-slate-400">Root's own processes, the services beside them and its server, read from root's cluster. Its alerts reach every operator, as chosen under Notifications.</p>
      <RootKoala />
      {overview.isPending && <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={12} className="animate-spin" /> Reading root's cluster…</div>}
      {overview.isError && <p className="text-xs text-rose-300">{errorMessage(overview.error)}</p>}
      {overview.data && !root && <p className="text-xs text-amber-300">Root's cluster is not answering, so its health cannot be read.</p>}
      {root && <ClusterHealth clusterId={root.id} grafana={false} />}
    </section>
  )
}
