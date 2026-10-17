import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  clearFailures, getClusterContents, getInfrastructure, infrastructureKeys,
  type WorkloadAbout, type WorkloadGroup, type WorkloadState,
} from '../../api/infrastructure'
import type { AppRow, ClusterRow } from '../../api/monitoring'
import type { RunningItem } from '../../api/running'
import type { Cluster } from '../../types/cluster'
import type { Deployment } from '../../types/deployment'
import { formatHash } from '../../lib/route'

export { healthHash, tabHash, bytes, percent, rate, seconds } from '../Monitoring/shared'

export const INFRASTRUCTURE_POLL_MS = 15_000
export const CLUSTER_CONTENTS_POLL_MS = 20_000

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'apps', label: 'Apps' },
  { id: 'clusters', label: 'Clusters' },
  { id: 'running', label: 'Running' },
] as const

export type TabId = (typeof TABS)[number]['id']

export const isTab = (value: string | undefined): value is TabId => TABS.some((tab) => tab.id === value)

export function useInfrastructure() {
  return useQuery({ queryKey: infrastructureKeys.overview(), queryFn: getInfrastructure, refetchInterval: INFRASTRUCTURE_POLL_MS })
}

export function useClusterContents(id: string) {
  return useQuery({ queryKey: infrastructureKeys.cluster(id), queryFn: () => getClusterContents(id), refetchInterval: CLUSTER_CONTENTS_POLL_MS })
}

export function useClearFailures() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids?: string[]) => clearFailures(ids),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: infrastructureKeys.overview() }) },
  })
}

export const WORKLOAD_LOOK: Record<WorkloadState | 'absent', { label: string; dot: string; text: string }> = {
  ok: { label: 'Running', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  starting: { label: 'Starting', dot: 'bg-sky-400', text: 'text-sky-300' },
  warning: { label: 'Needs attention', dot: 'bg-amber-400', text: 'text-amber-300' },
  down: { label: 'Broken', dot: 'bg-rose-500', text: 'text-rose-300' },
  absent: { label: 'Not installed', dot: 'bg-slate-600', text: 'text-slate-500' },
}

export const GROUPS: Array<{ id: WorkloadGroup; title: string; explain: string }> = [
  { id: 'apps', title: 'Apps', explain: 'Apps deployed through Koala.' },
  { id: 'koala', title: 'Koala\'s work', explain: 'Run sandboxes, release slots and builds.' },
  { id: 'platform', title: 'The platform', explain: 'What every cluster runs so Koala can work: monitoring, routing, repositories, secrets.' },
  { id: 'other', title: 'Not deployed through Koala', explain: 'Anything put on the cluster another way.' },
]

export function aboutLink(about: WorkloadAbout): { href: string; label: string } | undefined {
  const theirs = (what: string) => ('check' in about && about.check ? `left by a check, its ${what}` : `someone else's ${what}`)
  switch (about.kind) {
    case 'app': return about.mine ? { href: formatHash('infrastructure', ['app', about.id]), label: about.name } : { href: '', label: `${about.name}, someone else's app` }
    case 'tree': return about.mine ? { href: formatHash('projects', ['tree', about.id]), label: 'its tree' } : { href: '', label: theirs('tree') }
    case 'project': return about.mine ? { href: formatHash('projects', ['project', about.id]), label: 'its project' } : { href: '', label: theirs('project') }
    case 'run': return about.mine ? { href: '', label: `run ${about.id}` } : { href: '', label: theirs('run') }
    case 'builds': return { href: '', label: 'project builds' }
    default: return undefined
  }
}

export function waitingText(item: RunningItem): string {
  const asks = item.asking?.length ?? 0
  if (asks) return `waits for you to allow ${asks === 1 ? 'a call' : `${asks} calls`}`
  return 'waits for your answer'
}

export function appRows(deployments: readonly Deployment[], health: readonly AppRow[]): Array<{ deployment: Deployment; health?: AppRow }> {
  const byId = new Map(health.map((row) => [row.id, row]))
  const order = new Map(health.map((row, index) => [row.id, index]))
  return [...deployments]
    .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name))
    .map((deployment) => {
      const row = byId.get(deployment.id)
      return row ? { deployment, health: row } : { deployment }
    })
}

export function clusterCards(clusters: readonly Cluster[], health: readonly ClusterRow[]): Array<{ cluster: Cluster; health?: ClusterRow }> {
  const byId = new Map(health.map((row) => [row.id, row]))
  return [...clusters]
    .sort((a, b) => Number(Boolean(b.isSystem)) - Number(Boolean(a.isSystem)) || a.name.localeCompare(b.name))
    .map((cluster) => {
      const row = byId.get(cluster.id)
      return row ? { cluster, health: row } : { cluster }
    })
}
