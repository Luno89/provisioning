import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getAlerts, getAppHealth, getClusterHealth, getOverview, monitoringKeys, removeAlertRule, setHistoryDays,
  type HealthState, type Range,
} from '../../api/monitoring'
import { formatHash } from '../../lib/route'

export const OVERVIEW_POLL_MS = 15_000
export const HEALTH_POLL_MS = 30_000

export function useOverview() {
  return useQuery({ queryKey: monitoringKeys.overview(), queryFn: getOverview, refetchInterval: OVERVIEW_POLL_MS })
}

export function useAlerts() {
  return useQuery({ queryKey: monitoringKeys.alerts(), queryFn: getAlerts, refetchInterval: OVERVIEW_POLL_MS })
}

export function useAppHealth(id: string, range: Range) {
  return useQuery({ queryKey: monitoringKeys.app(id, range), queryFn: () => getAppHealth(id, range), refetchInterval: HEALTH_POLL_MS })
}

export function useClusterHealth(id: string, range: Range) {
  return useQuery({ queryKey: monitoringKeys.cluster(id, range), queryFn: () => getClusterHealth(id, range), refetchInterval: HEALTH_POLL_MS })
}

export function useSetHistory(clusterId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (days: number) => setHistoryDays(clusterId, days),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: monitoringKeys.all() }) },
  })
}

export function useRemoveRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => removeAlertRule(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: monitoringKeys.all() }) },
  })
}

export const STATE_LOOK: Record<HealthState, { label: string; dot: string; text: string }> = {
  ok: { label: 'Healthy', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  warning: { label: 'Needs attention', dot: 'bg-amber-400', text: 'text-amber-300' },
  down: { label: 'Down', dot: 'bg-rose-500', text: 'text-rose-300' },
  unreachable: { label: 'Unreachable', dot: 'bg-slate-500', text: 'text-slate-400' },
  installing: { label: 'Getting monitoring', dot: 'bg-sky-400', text: 'text-sky-300' },
}

export const percent = (value: number | undefined): string => (value === undefined ? '—' : `${Math.round(value * 100)}%`)

export function seconds(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value < 0.01) return `${(value * 1000).toFixed(1)} ms`
  return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(value < 10 ? 1 : 0)} s`
}

export function bytes(value: number | undefined): string {
  if (value === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
  return `${size.toFixed(size < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`
}

export const rate = (value: number | undefined): string => (value === undefined ? 'not counted' : value < 0.1 ? '<0.1/s' : `${value.toFixed(1)}/s`)

export type ChartUnit = 'share' | 'seconds' | 'rate' | 'up'

export const CHARTS: Record<string, { title: string; unit: ChartUnit }> = {
  up: { title: 'Answering', unit: 'up' },
  responseSeconds: { title: 'Response time', unit: 'seconds' },
  memoryShare: { title: 'Memory, of its limit', unit: 'share' },
  cpuShare: { title: 'CPU, of its limit', unit: 'share' },
  requestsPerSecond: { title: 'Requests', unit: 'rate' },
  errorShare: { title: 'Requests failing', unit: 'share' },
  diskShare: { title: 'Disk used', unit: 'share' },
}

export function formatValue(unit: ChartUnit, value: number): string {
  if (unit === 'share') return percent(value)
  if (unit === 'seconds') return seconds(value)
  if (unit === 'rate') return rate(value)
  return value >= 1 ? 'yes' : 'no'
}

export const healthHash = (kind: 'app' | 'cluster', id: string): string => formatHash('infrastructure', [kind, id])

export const tabHash = (tab: 'overview' | 'apps' | 'clusters' | 'running'): string => formatHash('infrastructure', tab === 'overview' ? [] : [tab])

export const RANGE_SECONDS: Record<Range, number> = { '1h': 3600, '24h': 86_400, '7d': 604_800, '30d': 2_592_000 }

export function windowOf(range: Range, now = Date.now()): { from: number; to: number } {
  const to = Math.floor(now / 1000)
  return { from: to - RANGE_SECONDS[range], to }
}

export const RANGE_LABELS: Record<Range, string> = { '1h': 'Hour', '24h': 'Day', '7d': 'Week', '30d': 'Month' }
